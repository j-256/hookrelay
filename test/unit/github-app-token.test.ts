import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  githubAppKeyFingerprint,
  evictGitHubInstallationToken,
  mintGitHubInstallationToken,
  signGitHubAppJwt,
  verifyGitHubInstallation,
} from '../../src/lib/github-app-token'
import { githubAuthIdentity, githubAuthDescriptorSchema } from '../../src/lib/github-auth'
let key: string
let publicKey: CryptoKey
const now = Date.parse('2026-11-10T12:00:00Z')
const repo = { id: 101, full_name: 'example/repository', private: true, owner: { id: 50 } }
const installation = {
  id: 7,
  app_id: 42,
  account: { id: 50, login: 'example', type: 'Organization' },
  permissions: { repository_hooks: 'write' },
  suspended_at: null,
}
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  publicKey = pair.publicKey
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  )
  key =
    '-----BEGIN PRIVATE KEY-----\n' +
    btoa(String.fromCharCode(...der)) +
    '\n-----END PRIVATE KEY-----\n'
})
const response = (overrides = {}) => ({
  token: 'synthetic-token',
  expires_at: new Date(now + 3600000).toISOString(),
  permissions: { repository_hooks: 'write' },
  repositories: [repo],
  ...overrides,
})
const request = async (fetcher: typeof fetch) => ({
  appId: 42,
  installationId: 7,
  accountId: 50,
  privateKey: key,
  fingerprint: await githubAppKeyFingerprint(key),
  repositories: [{ id: 101, fullName: repo.full_name, ownerId: 50, private: true }],
  capability: 'repository-hooks-write' as const,
  now: () => now,
  fetch: fetcher,
  cache: false,
  authorityIdentity: 'a'.repeat(64),
})
describe('native App token protocol', () => {
  it('signs verifiable RS256 claims with bounded skew and expiry', async () => {
    const jwt = await signGitHubAppJwt(key, 42, now)
    const [head, body, signature] = jwt.split('.') as [string, string, string]
    const decode = (v: string) =>
      Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
    expect(JSON.parse(new TextDecoder().decode(decode(head))).alg).toBe('RS256')
    expect(JSON.parse(new TextDecoder().decode(decode(body)))).toEqual({
      iss: '42',
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
    })
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        decode(signature),
        new TextEncoder().encode(head + '.' + body),
      ),
    ).toBe(true)
  })
  it('verifies exact installation ownership and refuses suspension and substitutions', async () => {
    const base = await request(async () => Response.json(installation))
    expect((await verifyGitHubInstallation(base)).accountId).toBe(50)
    for (const extra of [
      { app_id: 43 },
      { id: 8 },
      { account: { ...installation.account, id: 51 } },
      { suspended_at: '2026-11-10T11:00:00Z' },
      { permissions: {} },
    ])
      await expect(
        verifyGitHubInstallation({
          ...base,
          fetch: async () => Response.json({ ...installation, ...extra }),
        }),
      ).rejects.toThrow()
  })
  it('narrows repository IDs and permissions and rejects excess returned authority', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/app/installations/7/access_tokens')
      expect(init?.redirect).toBe('manual')
      expect(JSON.parse(String(init?.body))).toEqual({
        repository_ids: [101],
        permissions: { repository_hooks: 'write' },
      })
      return Response.json(response())
    })
    const base = await request(fetcher)
    expect((await mintGitHubInstallationToken(base)).token).toBe('synthetic-token')
    for (const extra of [
      { repositories: [repo, { ...repo, id: 102 }] },
      { permissions: { repository_hooks: 'write', contents: 'read' } },
      { expires_at: new Date(now + 30000).toISOString() },
      { repositories: [] },
      { token: 'invalid\n' },
    ])
      await expect(
        mintGitHubInstallationToken({ ...base, fetch: async () => Response.json(response(extra)) }),
      ).rejects.toThrow()
  })
  it('coalesces identical mints and renews after the expiry margin', async () => {
    let clock = now
    let calls = 0
    const base = {
      ...(await request(async () =>
        Response.json(
          response({
            token: 'synthetic-' + ++calls,
            expires_at: new Date(clock + 3600000).toISOString(),
          }),
        ),
      )),
      cache: true,
      now: () => clock,
    }
    const results = await Promise.all([
      mintGitHubInstallationToken(base),
      mintGitHubInstallationToken(base),
    ])
    expect(calls).toBe(1)
    expect(results[0]!.token).toBe(results[1]!.token)
    clock += 3550000
    expect((await mintGitHubInstallationToken(base)).token).not.toBe(results[0]!.token)
  })
  it('refuses redirects, oversized responses, malformed bodies and excess local scope before accepting credentials', async () => {
    const base = await request(async () => new Response(null, { status: 302 }))
    for (const fetcher of [
      base.fetch,
      async () => new Response('x'.repeat(262145)),
      async () => Response.json({}),
    ])
      await expect(mintGitHubInstallationToken({ ...base, fetch: fetcher })).rejects.toThrow()
    await expect(mintGitHubInstallationToken({ ...base, repositories: [] })).rejects.toThrow()
  })
})
it('honors secondary-limit Retry-After responses from installation endpoints', async () => {
  const input = await request(async () =>
    Response.json({}, { status: 403, headers: { 'retry-after': '3600' } }),
  )
  await expect(mintGitHubInstallationToken(input)).rejects.toMatchObject({
    code: 'rate_limited',
    retryAt: now + 3600000,
  })
})
it('bounds a transport that never resolves headers even if it ignores the abort signal', async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {}))
  const input = { ...(await request(fetcher)), remainingBudgetMs: () => 50 }
  const outcome = await Promise.race([
    mintGitHubInstallationToken(input).then(
      () => 'success',
      (error) => (error as { code: string }).code,
    ),
    new Promise((resolve) => setTimeout(() => resolve('not_bounded'), 500)),
  ])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(outcome).toBe('unavailable')
})
it('serves the maximum repository set under both capability profiles with bounded eviction', async () => {
  let calls = 0
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls++
    const body = JSON.parse(String(init?.body))
    const id = body.repository_ids[0]
    return Response.json(
      response({
        token: 'synthetic-scope-' + id + '-' + calls,
        permissions: body.permissions,
        repositories: [{ ...repo, id, full_name: 'example/repository-' + id }],
      }),
    )
  })
  const base = { ...(await request(fetcher)), cache: true }
  for (const capability of ['repository-hooks-read', 'repository-hooks-write'] as const)
    for (let id = 1; id <= 100; id++) {
      await mintGitHubInstallationToken({
        ...base,
        capability,
        repositories: [{ id, fullName: 'example/repository-' + id, ownerId: 50, private: true }],
      })
    }
  expect(calls).toBe(200)
  await mintGitHubInstallationToken({
    ...base,
    capability: 'repository-hooks-write',
    repositories: [{ id: 100, fullName: 'example/repository-100', ownerId: 50, private: true }],
  })
  expect(calls).toBe(200)
})
it('refreshes provider evidence without reusing an old token and makes the new token available for warm reads', async () => {
  let calls = 0
  const base = {
    ...(await request(async () =>
      Response.json(response({ token: 'synthetic-refresh-' + ++calls })),
    )),
    cache: true,
  }
  const old = await mintGitHubInstallationToken(base)
  const fresh = await mintGitHubInstallationToken({ ...base, cache: 'refresh' } as any)
  expect(fresh.token).not.toBe(old.token)
  expect((await mintGitHubInstallationToken(base)).token).toBe(fresh.token)
  expect(calls).toBe(2)
})

it.each(['descriptor', 'revision', 'key revision', 'generation', 'workspace', 'caller'])(
  'isolates cached token material by local authority %s while sharing installation quota', async dimension => {
    let calls = 0
    const base = { ...(await request(async () => Response.json(response({ token: 'synthetic-identity-' + ++calls })))), cache: true }
    const descriptor = githubAuthDescriptorSchema.parse({
      id: 'cache-auth', revision: 1, keyRevision: 1, mode: 'app',
      appId: base.appId, installationId: base.installationId, accountId: base.accountId,
      fingerprint: base.fingerprint, repositories: base.repositories,
      keySecretName: 'GITHUB_APP_A', managementWorkspaces: ['alpha', 'beta'],
      capabilities: ['repository-hooks-write'], state: 'active',
    })
    const first = await githubAuthIdentity(descriptor, 1, 'alpha', 'caller', 101, base.capability)
    const changed = await githubAuthIdentity(
      { ...descriptor, ...(dimension === 'descriptor' ? { id: 'other-auth' } : {}),
        ...(dimension === 'revision' ? { revision: 2 } : {}),
        ...(dimension === 'key revision' ? { keyRevision: 2 } : {}) },
      dimension === 'generation' ? 2 : 1, dimension === 'workspace' ? 'beta' : 'alpha',
      dimension === 'caller' ? 'other-caller' : 'caller', 101, base.capability,
    )
    const original = await mintGitHubInstallationToken({ ...base, authorityIdentity: first.authorityIdentity })
    const other = await mintGitHubInstallationToken({ ...base, authorityIdentity: changed.authorityIdentity })
    expect(other.token).not.toBe(original.token)
    expect((await mintGitHubInstallationToken({ ...base, authorityIdentity: first.authorityIdentity })).token).toBe(original.token)
    expect(calls).toBe(2)
    expect(changed.quotaKey).toBe(first.quotaKey)
  },
)

it('requires an explicit valid local namespace for caching while allowing uncached minting', async () => {
  const fetcher = vi.fn(async () => Response.json(response()))
  const base = await request(fetcher)
  for (const authorityIdentity of [undefined, '', 'not-a-digest', { toString: () => 'c'.repeat(64) } as unknown as string])
    await expect(mintGitHubInstallationToken({ ...base, cache: true, authorityIdentity })).rejects.toMatchObject({ code: 'validation' })
  expect(fetcher).not.toHaveBeenCalled()
  expect((await mintGitHubInstallationToken({ ...base, cache: false, authorityIdentity: undefined })).token).toBe('synthetic-token')
})

it('does not accept a warm token for a substituted provider account', async () => {
  const fetcher = vi.fn(async () => Response.json(response()))
  const base = { ...(await request(fetcher)), cache: true }
  await mintGitHubInstallationToken(base)
  await expect(mintGitHubInstallationToken({ ...base, accountId: 51 })).rejects.toMatchObject({ code: 'denied' })
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('does not coalesce pending mints across local namespaces', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const base = { ...(await request(async () => {
    const sequence = ++calls
    await gate
    return Response.json(response({ token: 'synthetic-pending-' + sequence }))
  })), cache: true }
  const pending = [mintGitHubInstallationToken(base), mintGitHubInstallationToken({ ...base, authorityIdentity: 'b'.repeat(64) })]
  try { await vi.waitFor(() => expect(calls).toBe(2)) }
  finally { release(); await Promise.allSettled(pending) }
  const results = await Promise.all(pending)
  expect(results[0]!.token).not.toBe(results[1]!.token)
})

it('evicts only the selected local namespace', async () => {
  let calls = 0
  const base = { ...(await request(async () => Response.json(response({ token: 'synthetic-evict-' + ++calls })))), cache: true }
  await mintGitHubInstallationToken(base)
  const other = { ...base, authorityIdentity: 'b'.repeat(64) }
  const kept = await mintGitHubInstallationToken(other)
  evictGitHubInstallationToken(base)
  expect((await mintGitHubInstallationToken(other)).token).toBe(kept.token)
  await mintGitHubInstallationToken(base)
  expect(calls).toBe(3)
})

it('reuses one namespace for a repository set presented in a different order', async () => {
  const other = { ...repo, id: 102, full_name: 'example/other' }
  const fetcher = vi.fn(async () => Response.json(response({ repositories: [repo, other] })))
  const base = { ...(await request(fetcher)), cache: true }
  const repositories = [...base.repositories, { id: other.id, fullName: other.full_name, private: true, ownerId: 50 }]
  const first = await mintGitHubInstallationToken({ ...base, repositories })
  const reordered = await mintGitHubInstallationToken({ ...base, repositories: [...repositories].reverse() })
  expect(reordered.token).toBe(first.token)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('reports rejected installation-token scope with safe provider context and actionable recovery', async () => {
  const base = await request(async () => new Response('private-provider-body-canary', {status:422}));
  await expect(mintGitHubInstallationToken(base)).rejects.toMatchObject({code:'denied',providerStage:'installation_token',providerStatus:422,message:expect.stringContaining('repository selection and App permissions')});
  await expect(verifyGitHubInstallation(base)).rejects.toMatchObject({code:'unavailable',providerStage:'installation',providerStatus:422});
  try { await mintGitHubInstallationToken(base) } catch(error) { expect(String(error)).not.toMatch(/private-provider-body-canary|revoked/) }
});
