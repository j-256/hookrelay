import { beforeAll, describe, expect, it, vi } from 'vitest'
import { githubAppKeyFingerprint, mintGitHubInstallationToken, signGitHubAppJwt, verifyGitHubInstallation } from '../../src/lib/github-app-token'
let key: string
let publicKey: CryptoKey
const now = Date.parse('2026-11-10T12:00:00Z')
const repo = { id: 101, full_name: 'example/repository', private: true, owner: { id: 50 } }
const installation = { id: 7, app_id: 42, account: { id: 50, login: 'example', type: 'Organization' }, permissions: { repository_hooks: 'write' }, suspended_at: null }
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  publicKey = pair.publicKey
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
  key = '-----BEGIN PRIVATE KEY-----\n' + btoa(String.fromCharCode(...der)) + '\n-----END PRIVATE KEY-----\n'
})
const response = (overrides = {}) => ({ token: 'synthetic-token', expires_at: new Date(now + 3600000).toISOString(), permissions: { repository_hooks: 'write' }, repositories: [repo], ...overrides })
const request = async (fetcher: typeof fetch) => ({ appId: 42, installationId: 7, accountId: 50, privateKey: key, fingerprint: await githubAppKeyFingerprint(key), repositories: [{ id: 101, fullName: repo.full_name, ownerId: 50, private: true }], capability: 'repository-hooks-write' as const, now: () => now, fetch: fetcher, cache: false })
describe('native App token protocol', () => {
  it('signs verifiable RS256 claims with bounded skew and expiry', async () => {
    const jwt = await signGitHubAppJwt(key, 42, now)
    const [head, body, signature] = jwt.split('.') as [string, string, string]
    const decode = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    expect(JSON.parse(new TextDecoder().decode(decode(head))).alg).toBe('RS256')
    expect(JSON.parse(new TextDecoder().decode(decode(body)))).toEqual({ iss: '42', iat: now / 1000 - 60, exp: now / 1000 + 540 })
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(signature), new TextEncoder().encode(head + '.' + body))).toBe(true)
  })
  it('verifies exact installation ownership and refuses suspension and substitutions', async () => {
    const base = await request(async () => Response.json(installation))
    expect((await verifyGitHubInstallation(base)).accountId).toBe(50)
    for (const extra of [{ app_id: 43 }, { id: 8 }, { account: { ...installation.account, id: 51 } }, { suspended_at: '2026-11-10T11:00:00Z' }, { permissions: {} }])
      await expect(verifyGitHubInstallation({ ...base, fetch: async () => Response.json({ ...installation, ...extra }) })).rejects.toThrow()
  })
  it('narrows repository IDs and permissions and rejects excess returned authority', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.github.com/app/installations/7/access_tokens')
      expect(init?.redirect).toBe('manual')
      expect(JSON.parse(String(init?.body))).toEqual({ repository_ids: [101], permissions: { repository_hooks: 'write' } })
      return Response.json(response())
    })
    const base = await request(fetcher)
    expect((await mintGitHubInstallationToken(base)).token).toBe('synthetic-token')
    for (const extra of [{ repositories: [repo, { ...repo, id: 102 }] }, { permissions: { repository_hooks: 'write', contents: 'read' } }, { expires_at: new Date(now + 30000).toISOString() }, { repositories: [] }, { token: 'invalid\n' }])
      await expect(mintGitHubInstallationToken({ ...base, fetch: async () => Response.json(response(extra)) })).rejects.toThrow()
  })
  it('coalesces identical mints and renews after the expiry margin', async () => {
    let clock = now
    let calls = 0
    const base = { ...await request(async () => Response.json(response({ token: 'synthetic-' + ++calls, expires_at: new Date(clock + 3600000).toISOString() }))), cache: true, now: () => clock }
    const results = await Promise.all([mintGitHubInstallationToken(base), mintGitHubInstallationToken(base)])
    expect(calls).toBe(1)
    expect(results[0]!.token).toBe(results[1]!.token)
    clock += 3550000
    expect((await mintGitHubInstallationToken(base)).token).not.toBe(results[0]!.token)
  })
  it('refuses redirects, oversized responses, malformed bodies and excess local scope before accepting credentials', async () => {
    const base = await request(async () => new Response(null, { status: 302 }))
    for (const fetcher of [base.fetch, async () => new Response('x'.repeat(262145)), async () => Response.json({})])
      await expect(mintGitHubInstallationToken({ ...base, fetch: fetcher })).rejects.toThrow()
    await expect(mintGitHubInstallationToken({ ...base, repositories: [] })).rejects.toThrow()
  })
})
it('honors secondary-limit Retry-After responses from installation endpoints',async () => {
  const input=await request(async () => Response.json({},{status:403,headers:{'retry-after':'3600'}}))
  await expect(mintGitHubInstallationToken(input)).rejects.toMatchObject({code:'rate_limited',retryAt:now+3600000})
})
it('bounds a transport that never resolves headers even if it ignores the abort signal',async () => {
  const fetcher=vi.fn(() => new Promise<Response>(() => {}))
  const input={...await request(fetcher),remainingBudgetMs:() => 50}
  const outcome=await Promise.race([mintGitHubInstallationToken(input).then(() => 'success',error => (error as {code:string}).code),new Promise(resolve => setTimeout(() => resolve('not_bounded'),500))])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(outcome).toBe('unavailable')
})
