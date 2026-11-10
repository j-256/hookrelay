import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptConfigurationChange,
  configurationQuery,
  readConfigurationState,
} from '../../src/configuration/authority'
import {
  planGitHubSetup,
  applyGitHubSetup,
  getGitHubSetup,
  readGitHubSetupStatus,
} from '../../src/management/github-setup'
import { githubAppKeyFingerprint } from '../../src/lib/github-app-token'
import { resolveGitHubAuth } from '../../src/lib/github-auth'
import type { Env } from '../../src/index'
import type { GitHubAuthDescriptor } from '../../src/lib/github-app-contract'
const query = configurationQuery(env.EVENTS_DB)
const context = { workspaceId: 'alpha', actorId: 'owner' }
const principal = {
  id: 'setup-client',
  revision: 1,
  tokenHash: 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00.000Z',
  workspaceIds: ['alpha'],
  capabilities: ['read', 'provision'] as ['read', 'provision'],
}
let privateKey: string
let fingerprint: string
let runtime: Env
let descriptor: GitHubAuthDescriptor
let hooks: Record<string, any>[]
let creates: number
let minted: number
let lost: boolean
let outage: boolean
let revokeBeforeEffect: boolean
let localGrant: boolean
let authMode: 'app' | 'token'
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
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
  const bytes = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  )
  privateKey = [
    '-----BEGIN PRIVATE KEY-----',
    btoa(String.fromCharCode(...bytes)),
    '-----END PRIVATE KEY-----',
  ].join('\n')
  fingerprint = await githubAppKeyFingerprint(privateKey)
})
beforeEach(async () => {
  await env.EVENTS_DB.exec(
    "DELETE FROM github_setup_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns; UPDATE github_auth_runtime_policy SET mode='legacy',revision=1; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;",
  )
  hooks = []
  creates = 0
  minted = 0
  lost = false
  outage = false
  revokeBeforeEffect = false
  localGrant = true
  descriptor = {
    id: 'provider-app',
    revision: 1,
    keyRevision: 1,
    mode: 'app',
    appId: 42,
    installationId: 7,
    accountId: 50,
    keySecretName: 'GITHUB_APP_KEY_A',
    fingerprint,
    repositories: [{ id: 101, fullName: 'owner/repo', ownerId: 50, private: true }],
    managementWorkspaces: ['alpha'],
    capabilities: ['repository-hooks-write'],
    state: 'active',
  }
  runtime = new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === 'HOOK_SETUP_KEY') return 'synthetic-setup-root-secret-value-1234567890'
      if (prop === 'HOOK_SETUP_ORIGIN') return 'https://hooks.example'
      if (prop === 'HOOK_SETUP_GITHUB_TOKEN')
        return authMode === 'token' ? 'synthetic-manual-token' : undefined
      if (prop === 'GITHUB_APP_KEY_A') return privateKey
      if (prop === 'MANAGEMENT_CREDENTIALS')
        return JSON.stringify([
          { ...principal, capabilities: localGrant ? principal.capabilities : ['read'] },
        ])
      return Reflect.get(target, prop, receiver)
    },
  })
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, {
    ...context,
    clientId: 'operator',
    clientRevision: 1,
    authorityId: state.authorityId,
    expectedRevision: 0,
    kind: 'migration',
    operationId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    deletes: [],
    puts: [
      {
        namespace: 'SINKS',
        key: 'sink:phone',
        resourceId: crypto.randomUUID(),
        value: JSON.stringify({ type: 'ntfy', topic: 'synthetic' }),
      },
    ],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://api.github.com')
    expect(init?.redirect).toBe('manual')
    if (url.pathname === '/app/installations/7')
      return Response.json(
        outage
          ? {}
          : {
              id: 7,
              app_id: 42,
              account: { id: 50 },
              permissions: { repository_hooks: 'write' },
              suspended_at: null,
            },
        { status: outage ? 503 : 200 },
      )
    if (url.pathname.endsWith('/access_tokens')) {
      minted++
      expect(JSON.parse(String(init?.body)).repository_ids).toEqual([101])
      return Response.json({
        token: 'synthetic-app-token-' + minted,
        expires_at: new Date(Date.now() + 90000).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
        repositories: [{ id: 101, full_name: 'owner/repo', private: true, owner: { id: 50 } }],
      })
    }
    expect(url.pathname).toBe('/repos/owner/repo/hooks')
    expect(init?.headers).toBeTruthy()
    if (init?.method === 'POST') {
      creates++
      const body = JSON.parse(String(init.body))
      const hook = { ...body, id: 42, config: { ...body.config } }
      delete hook.config.secret
      hooks.push(hook)
      if (lost) throw new Error('lost-response-canary')
      return Response.json(hook, { status: 201 })
    }
    if (revokeBeforeEffect) localGrant = false
    return Response.json(hooks)
  })
})
afterEach(() => vi.restoreAllMocks())
async function app() {
  await env.EVENTS_DB.prepare(
    'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
  )
    .bind(descriptor.id, JSON.stringify(descriptor), crypto.randomUUID())
    .run()
  await env.EVENTS_DB.prepare("UPDATE github_auth_runtime_policy SET mode='registry'").run()
}
async function plan() {
  const state = await readConfigurationState(query)
  return planGitHubSetup(runtime, principal, {
    ...context,
    planId: crypto.randomUUID(),
    authorityId: state.authorityId,
    revision: state.revision,
    resourceId: null,
    name: 'repository-hooks',
    repository: 'owner/repo',
    events: ['push'],
    sinks: ['phone'],
  })
}
describe.each(['app', 'token'] as const)('%s reviewed setup', (mode) => {
  beforeEach(async () => {
    authMode = mode
    if (mode === 'app') await app()
  })
  it('installs one signed receiver with private credentials excluded from the public contract', async () => {
    const review = await plan()
    const applied = await applyGitHubSetup(runtime, principal, {
      ...context,
      planId: review.planId,
    })
    expect(applied).toMatchObject({
      status: 'installed',
      webhookInstalled: true,
      routingConfigured: true,
    })
    expect(creates).toBe(1)
    expect(JSON.stringify(applied)).not.toMatch(
      /PRIVATE KEY|synthetic-app-token|synthetic-manual-token|\/hook\/github\//,
    )
    await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
    expect(creates).toBe(1)
  })
  it('preserves an indeterminate claim without replaying an ambiguous creation', async () => {
    const review = await plan()
    lost = true
    expect(
      (await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
    ).toBe('indeterminate')
    await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
    expect(creates).toBe(1)
    expect(
      (await getGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
    ).toBe('installed')
  })
  it('refuses a management grant removed after inventory and before create', async () => {
    const review = await plan()
    revokeBeforeEffect = true
    const applied = await applyGitHubSetup(runtime, principal, {
      ...context,
      planId: review.planId,
    })
    expect(creates).toBe(0)
    expect(applied.webhookInstalled).toBe(false)
  })
})
it('keeps a saved App review stable across ordinary token renewal', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const initial = await env.EVENTS_DB.prepare(
    'SELECT configuration_digest FROM github_setup_reviews WHERE id=?',
  )
    .bind(review.planId)
    .first('configuration_digest')
  await env.EVENTS_DB.prepare('UPDATE github_auth_authority SET valid_until=0').run()
  expect(
    (await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
  ).toBe('installed')
  expect(minted).toBeGreaterThan(1)
  expect(
    await env.EVENTS_DB.prepare('SELECT configuration_digest FROM github_setup_reviews WHERE id=?')
      .bind(review.planId)
      .first('configuration_digest'),
  ).toBe(initial)
})
it.each(['revision', 'workspace', 'repository', 'key'])(
  'rejects a changed %s before setup effects',
  async (kind) => {
    authMode = 'app'
    await app()
    const review = await plan()
    const next = {
      ...descriptor,
      revision: 2,
      ...(kind === 'workspace'
        ? { managementWorkspaces: ['beta'] }
        : kind === 'repository'
          ? { repositories: [{ ...descriptor.repositories[0]!, id: 102 }] }
          : kind === 'key'
            ? { keyRevision: 2, fingerprint: 'b'.repeat(64) }
            : {}),
    }
    await env.EVENTS_DB.prepare(
      'UPDATE github_auth_descriptors SET revision=2,key_revision=?,metadata_json=?',
    )
      .bind(next.keyRevision, JSON.stringify(next))
      .run()
    await expect(
      applyGitHubSetup(runtime, principal, { ...context, planId: review.planId }),
    ).rejects.toThrow()
    expect(creates).toBe(0)
  },
)
it('blocks fresh-effect verification outages without sending a hook create', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const result = await original(url, init)
    if (String(url).includes('/hooks')) outage = true
    return result
  })
  const applied = await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  expect(creates).toBe(0)
  expect(applied.webhookInstalled).toBe(false)
})
it.each(['active', 'legacy'] as const)(
  'resolves App authority independently of %s routing',
  async (routing) => {
    authMode = 'app'
    await app()
    await env.EVENTS_DB.prepare('UPDATE configuration_authority SET mode=?').bind(routing).run()
    const lease = await resolveGitHubAuth({
      query,
      selection: { mode: 'app', descriptorId: 'provider-app' },
      workspaceId: 'alpha',
      callerId: 'client:owner',
      repositoryFullName: 'owner/repo',
      capability: 'repository-hooks-write',
      phase: 'read',
      loadPrivateKey: async () => privateKey,
    })
    expect(lease.fence.repositoryId).toBe(101)
    expect(lease.validUntil).toBeLessThanOrEqual(Date.now() + 60000)
  },
)
it('remints once only after an explicit App 401 and preserves the serialized hook input', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const original = vi.mocked(fetch).getMockImplementation()!
  const bodies: string[] = []
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/hooks') && init?.method === 'POST') {
      bodies.push(String(init.body))
      if (bodies.length === 1) return Response.json({}, { status: 401 })
    }
    return original(url, init)
  })
  expect(
    (await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
  ).toBe('installed')
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toBe(bodies[1])
  expect(creates).toBe(1)
})
it('does not retry an App create after a provider 5xx or change to the manual credential', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  let attempts = 0
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/hooks') && init?.method === 'POST') {
      attempts++
      return Response.json({}, { status: 503 })
    }
    return original(url, init)
  })
  expect(
    (await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
  ).toBe('indeterminate')
  await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  expect(attempts).toBe(1)
})
it('records hook-response rate limits across workspaces sharing the installation', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const beta = { ...descriptor, id: 'beta-app', managementWorkspaces: ['beta'] }
  await env.EVENTS_DB.prepare(
    'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
  )
    .bind(beta.id, JSON.stringify(beta), crypto.randomUUID())
    .run()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).includes('/hooks') && init?.method === 'POST'
      ? Response.json({}, { status: 429, headers: { 'retry-after': '3600' } })
      : original(url, init),
  )
  await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  const before = vi.mocked(fetch).mock.calls.length
  await expect(
    resolveGitHubAuth({
      query,
      selection: { mode: 'app', descriptorId: beta.id },
      workspaceId: 'beta',
      callerId: 'owner',
      repositoryFullName: 'owner/repo',
      capability: 'repository-hooks-write',
      phase: 'effect',
      loadPrivateKey: async () => privateKey,
    }),
  ).rejects.toMatchObject({ code: 'rate_limited' })
  expect(vi.mocked(fetch).mock.calls).toHaveLength(before)
})
it('preserves a confirmed hook acknowledgement but removes current verification after authority loss during POST', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const response = await original(url, init)
    if (String(url).includes('/hooks') && init?.method === 'POST')
      await env.EVENTS_DB.prepare(
        "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2,'$.state','disconnected')",
      ).run()
    return response
  })
  const applied = await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  expect(applied).toMatchObject({
    status: 'installed',
    webhookId: 42,
    webhookInstalled: true,
    errorCode: 'github_unavailable',
  })
  expect(creates).toBe(1)
  expect(
    (await readGitHubSetupStatus(runtime, review.resourceId, principal, context)).webhook,
  ).toBe('unavailable')
})
it('fences a successful acknowledgement when authority changes just before the D1 receipt write', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  let intercepted = false
  const database = new Proxy(env.EVENTS_DB, {
    get(target, prop, receiver) {
      if (prop === 'prepare')
        return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sql.includes("SET state='installed'") || !sql.includes('CASE WHEN')) return statement
          return {
            bind: (...params: (string | number | null)[]) => ({
              run: async () => {
                intercepted = true
                await target
                  .prepare(
                    "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2)",
                  )
                  .run()
                return statement.bind(...params).run()
              },
            }),
          }
        }
      return Reflect.get(target, prop, receiver)
    },
  })
  const scoped = new Proxy(runtime, {
    get(target, prop, receiver) {
      return prop === 'EVENTS_DB' ? database : Reflect.get(target, prop, receiver)
    },
  })
  const applied = await applyGitHubSetup(scoped, principal, { ...context, planId: review.planId })
  expect(intercepted).toBe(true)
  expect(applied).toMatchObject({
    status: 'installed',
    webhookInstalled: true,
    errorCode: 'github_unavailable',
  })
})
it('denies a read-only App profile and fails closed instead of trying a configured manual token', async () => {
  authMode = 'token'
  await app()
  await env.EVENTS_DB.prepare(
    "UPDATE github_auth_descriptors SET metadata_json=json_set(metadata_json,'$.capabilities',json('[\"repository-hooks-read\"]'))",
  ).run()
  await expect(plan()).rejects.toMatchObject({ code: 'denied' })
  expect(vi.mocked(fetch).mock.calls).toEqual([])
})
it('bounds provider evidence age from verification start rather than after delayed minting', async () => {
  authMode = 'app'
  await app()
  let time = Date.now()
  const start = time
  const original = vi.mocked(fetch).getMockImplementation()!
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(url, init)
    time += 10000
    return response
  })
  const lease = await resolveGitHubAuth({
    query,
    selection: { mode: 'app', descriptorId: 'provider-app' },
    workspaceId: 'alpha',
    callerId: 'owner',
    repositoryFullName: 'owner/repo',
    capability: 'repository-hooks-write',
    phase: 'effect',
    loadPrivateKey: async () => privateKey,
    fetch: fetcher,
    now: () => time,
  })
  expect(lease.validUntil).toBeLessThanOrEqual(start + 60000)
})
it('shows a saved review as conflicted after its captured App authority changes locally', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  await env.EVENTS_DB.prepare(
    "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2)",
  ).run()
  expect(
    (await getGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
  ).toBe('conflict')
})
it('keeps authority-loss receipts within the existing strict public error-code contract', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const response = await original(url, init)
    if (String(url).includes('/hooks') && init?.method === 'POST')
      await env.EVENTS_DB.prepare(
        "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2)",
      ).run()
    return response
  })
  const applied = await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  expect(['github_rejected', 'github_unavailable', 'github_limited']).toContain(applied.errorCode)
  expect(applied.webhookInstalled).toBe(applied.status === 'installed')
  expect(
    await env.EVENTS_DB.prepare('SELECT error_code FROM github_setup_reviews WHERE id=?')
      .bind(review.planId)
      .first('error_code'),
  ).toBe('authority_changed')
})
it('retains a known 201 acknowledgement when its resource confirmation body cannot be parsed', async () => {
  authMode = 'app'
  await app()
  const review = await plan()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const response = await original(url, init)
    return String(url).includes('/hooks') && init?.method === 'POST'
      ? new Response('truncated', { status: 201 })
      : response
  })
  expect(
    (await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })).status,
  ).toBe('indeterminate')
  expect(
    await env.EVENTS_DB.prepare('SELECT error_code FROM github_setup_reviews WHERE id=?')
      .bind(review.planId)
      .first('error_code'),
  ).toBe('acknowledged_unverified')
  await applyGitHubSetup(runtime, principal, { ...context, planId: review.planId })
  expect(creates).toBe(1)
})
it('uses a read-only token for read capability inherited from a write grant', async () => {
  authMode = 'app'
  await app()
  const original = vi.mocked(fetch).getMockImplementation()!
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/access_tokens')) {
      expect(JSON.parse(String(init?.body)).permissions).toEqual({ repository_hooks: 'read' })
      return Response.json({
        token: 'synthetic-read-token',
        expires_at: new Date(Date.now() + 90000).toISOString(),
        permissions: { repository_hooks: 'read' },
        repositories: [{ id: 101, full_name: 'owner/repo', private: true, owner: { id: 50 } }],
      })
    }
    return original(url, init)
  })
  const lease = await resolveGitHubAuth({
    query,
    selection: { mode: 'app', descriptorId: 'provider-app' },
    workspaceId: 'alpha',
    callerId: 'reader',
    repositoryFullName: 'owner/repo',
    capability: 'repository-hooks-read',
    phase: 'read',
    loadPrivateKey: async () => privateKey,
    fetch: fetcher,
  })
  expect(lease.fence.capability).toBe('repository-hooks-read')
})
