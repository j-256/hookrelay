import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configurationQuery } from '../../../../src/configuration/authority'
import { githubAppKeyFingerprint } from '../../../../src/lib/github-app-token'
import { githubTokenFingerprint } from '../../../../src/lib/github-auth'
import {
  resolveOperatorGitHubAuth,
  extractOperatorGitHubAuthArgs,
} from '../../../../scripts/providers/github/auth'
const query = configurationQuery(env.EVENTS_DB)
let privateKey: string
let fingerprint: string
const token = 'synthetic-manual-token'
const hook = {
  id: 10,
  active: true,
  events: ['push'],
  config: {
    url: 'https://hooks.example/hook/github/synthetic-private-slug-value',
    content_type: 'json',
    insecure_ssl: '0',
  },
}
const effect = {
  repo: 'owner/repo',
  hookId: 10,
  webhookUrl: hook.config.url,
  secret: 'synthetic-hook-secret',
  events: ['push'],
}
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
    'DELETE FROM github_hook_operations; DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns;',
  )
})
async function fixture(mode: 'app' | 'token' | 'gh', routing: 'active' | 'legacy') {
  await env.EVENTS_DB.prepare('UPDATE configuration_authority SET mode=?').bind(routing).run()
  const descriptor = {
    id: 'operator-auth',
    revision: 1,
    keyRevision: 1,
    mode,
    ...(mode === 'app'
      ? {
          appId: 42,
          installationId: 7,
          accountId: 50,
          keySecretName: 'GITHUB_APP_KEY_A',
          fingerprint,
        }
      : mode === 'token'
        ? { tokenSecretName: 'GITHUB_MANUAL_A', fingerprint: await githubTokenFingerprint(token) }
        : {}),
    repositories: [{ id: 101, fullName: 'owner/repo', ownerId: 50, private: true }],
    managementWorkspaces: ['alpha'],
    capabilities: ['repository-hooks-read', 'repository-hooks-write'],
    state: 'active',
  }
  if (mode !== 'gh')
    await env.EVENTS_DB.prepare(
      'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
    )
      .bind(descriptor.id, JSON.stringify(descriptor), crypto.randomUUID())
      .run()
  const calls: { url: string; method: string; body: unknown }[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(input), method: init?.method ?? 'GET', body })
    expect(url.origin).toBe('https://api.github.com')
    expect(init?.redirect).toBe('manual')
    if (url.pathname === '/app/installations/7')
      return Response.json({
        id: 7,
        app_id: 42,
        account: { id: 50 },
        permissions: { repository_hooks: 'write' },
        suspended_at: null,
      })
    if (url.pathname.endsWith('/access_tokens')) {
      expect(body.repository_ids).toEqual([101])
      return Response.json({
        token: 'synthetic-app-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repositories: [{ id: 101, full_name: 'owner/repo', private: true, owner: { id: 50 } }],
      })
    }
    const authorization = new Headers(init?.headers).get('authorization')
    expect(authorization).toBe('Bearer ' + (mode === 'app' ? 'synthetic-app-token' : token))
    if (url.pathname === '/repos/owner/repo')
      return Response.json({
        id: 101,
        full_name: 'owner/repo',
        private: true,
        owner: { id: 50 },
        fork: false,
        archived: false,
        permissions: { admin: false },
      })
    if (url.pathname.endsWith('/deliveries')) return Response.json([])
    if (url.pathname.endsWith('/pings') || init?.method === 'DELETE')
      return new Response(null, { status: 204 })
    if (init?.method === 'POST') return Response.json(hook, { status: 201 })
    if (init?.method === 'PATCH') return Response.json(hook)
    return Response.json([])
  })
  const runner = vi.fn(async (command: string, args: string[], options?: { input?: string }) => {
    expect(command).toBe('gh')
    expect(
      args.some((arg) => arg.includes('synthetic-hook-secret') || arg.includes('/hook/github/')),
    ).toBe(false)
    const method = args[args.indexOf('--method') + 1]
    if (options?.input) {
      expect(JSON.parse(options.input).config.secret).toBe('synthetic-hook-secret')
    }
    if (args.includes('--include') && args.some(arg => arg.includes('/deliveries?'))) return 'HTTP/2.0 200 OK\r\n\r\n[]'
    return method === 'POST' && !args.some((arg) => arg.endsWith('/pings'))
      ? JSON.stringify(hook)
      : method === 'PATCH'
        ? JSON.stringify(hook)
        : method === 'GET'
          ? '[]'
          : ''
  })
  const deps = {
    query,
    fetch: fetcher,
    runner,
    readAppMaterial: async () => ({
      version: 1 as const,
      kind: 'github-app' as const,
      app: {
        id: 42,
        slug: 'operator',
        ownerId: 50,
        ownerLogin: 'owner',
        ownerType: 'Organization' as const,
      },
      privateKey,
      fingerprint,
      createdAt: new Date().toISOString(),
    }),
    readTokenMaterial: async () => token,
  }
  const options = {
    mode,
    descriptorId: mode === 'gh' ? undefined : descriptor.id,
    workspaceId: mode === 'gh' ? undefined : 'alpha',
    credentialFile: mode === 'gh' ? undefined : 'synthetic-private-file',
    config: 'wrangler.jsonc',
  }
  return {
    auth: await resolveOperatorGitHubAuth(options, deps),
    calls,
    runner,
    fetcher,
    deps,
    options,
  }
}
describe.each(['app', 'token', 'gh'] as const)('%s native hook transport', (mode) => {
  it.each(['active', 'legacy'] as const)(
    'covers every bounded operation under %s routing',
    async (routing) => {
      const { auth, runner } = await fixture(mode, routing)
      for (const operation of [
        'list',
        'create',
        'update',
        'events',
        'delete',
        'deliveries',
        'ping',
      ] as const) {
        const request =
          operation === 'list'
            ? { operation, repo: effect.repo }
            : operation === 'deliveries' || operation === 'delete' || operation === 'ping'
              ? { operation, repo: effect.repo, hookId: effect.hookId }
              : operation === 'create'
                ? {
                    operation,
                    repo: effect.repo,
                    webhookUrl: effect.webhookUrl,
                    secret: effect.secret,
                    events: effect.events,
                  }
                : { ...effect, operation, active: true }
        await auth.transport.request(request)
      }
      expect(auth.metadata.mode).toBe(mode)
      expect(JSON.stringify(auth.metadata)).not.toMatch(
        /PRIVATE KEY|synthetic-manual-token|synthetic-app-token/,
      )
      if (mode !== 'gh') expect(runner).not.toHaveBeenCalled()
    },
  )
})
it('refuses stale private material, registry failure and local extra repository claims without gh fallback', async () => {
  const { deps, options, runner, fetcher } = await fixture('app', 'active')
  await expect(
    resolveOperatorGitHubAuth(options, {
      ...deps,
      readAppMaterial: async () => ({
        ...(await deps.readAppMaterial()),
        fingerprint: 'b'.repeat(64),
      }),
    }),
  ).rejects.toThrow()
  await expect(
    resolveOperatorGitHubAuth(options, {
      ...deps,
      query: async () => {
        throw new Error('private-error-canary')
      },
    }),
  ).rejects.toThrow()
  const auth = await resolveOperatorGitHubAuth(options, deps)
  await expect(auth.transport.request({ operation: 'list', repo: 'owner/extra' })).rejects.toThrow()
  expect(runner).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})
it('requires one explicit mode and separates authentication flags from command arguments', () => {
  expect(
    extractOperatorGitHubAuthArgs([
      'name',
      '--github-auth=app',
      '--github-descriptor',
      'operator-auth',
      '--github-credential-file',
      'private-input',
      '--github-workspace',
      'alpha',
      '-y',
    ]),
  ).toMatchObject({
    args: ['name', '-y'],
    authentication: {
      mode: 'app',
      descriptorId: 'operator-auth',
      credentialFile: 'private-input',
      workspaceId: 'alpha',
    },
  })
  for (const args of [
    ['--github-auth', 'unknown'],
    ['--github-auth', 'app', '--github-auth', 'gh'],
    ['--github-token', 'secret'],
  ])
    expect(() => extractOperatorGitHubAuthArgs(args)).toThrow()
})
it('persists effect intent before dispatch and keeps credentials out of its durable metadata', async () => {
  const { auth, deps } = await fixture('app', 'active')
  const original = deps.fetch.getMockImplementation()!
  deps.fetch.mockImplementation(async (url, init) => {
    if (String(url).includes('/repos/') && init?.method === 'POST')
      expect(
        await env.EVENTS_DB.prepare(
          "SELECT state FROM github_hook_operations WHERE state='submitting'",
        ).first('state'),
      ).toBe('submitting')
    return original(url, init)
  })
  await auth.transport.request({
    operation: 'create',
    repo: effect.repo,
    webhookUrl: effect.webhookUrl,
    secret: effect.secret,
    events: effect.events,
  })
  const row = await env.EVENTS_DB.prepare('SELECT * FROM github_hook_operations').first()
  expect(row).toMatchObject({ state: 'accepted', verified: 1, provider_status: 201 })
  expect(JSON.stringify(row)).not.toMatch(
    /synthetic-hook-secret|synthetic-app-token|PRIVATE KEY|\/hook\/github\//,
  )
})
it('preserves an ambiguous native effect and refuses a second unresolved dispatch across contexts', async () => {
  const { auth, deps, options } = await fixture('app', 'active')
  const original = deps.fetch.getMockImplementation()!
  let dispatches = 0
  deps.fetch.mockImplementation(async (url, init) => {
    if (String(url).includes('/repos/') && init?.method === 'POST') {
      dispatches++
      throw new Error('lost-response-canary')
    }
    return original(url, init)
  })
  const request = {
    operation: 'create' as const,
    repo: effect.repo,
    webhookUrl: effect.webhookUrl,
    secret: effect.secret,
    events: effect.events,
  }
  await expect(auth.transport.request(request)).rejects.toMatchObject({ code: 'indeterminate' })
  expect(
    await env.EVENTS_DB.prepare('SELECT state FROM github_hook_operations').first('state'),
  ).toBe('indeterminate')
  const next = await resolveOperatorGitHubAuth(options, deps)
  await expect(next.transport.request(request)).rejects.toMatchObject({ code: 'indeterminate' })
  expect(dispatches).toBe(1)
})
it('reports actual hook throttling and shares its cooldown with another workspace descriptor', async () => {
  const { auth, deps, options } = await fixture('app', 'active')
  const [row] = await query<{ metadata_json: string }>({
    sql: 'SELECT metadata_json FROM github_auth_descriptors WHERE id=?',
    params: ['operator-auth'],
  })
  const beta = {
    ...JSON.parse(row!.metadata_json),
    id: 'beta-auth',
    managementWorkspaces: ['beta'],
  }
  await env.EVENTS_DB.prepare(
    'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
  )
    .bind(beta.id, JSON.stringify(beta), crypto.randomUUID())
    .run()
  const original = deps.fetch.getMockImplementation()!
  deps.fetch.mockImplementation(async (url, init) =>
    String(url).includes('/repos/') && init?.method === 'POST'
      ? Response.json({}, { status: 429, headers: { 'retry-after': '3600' } })
      : original(url, init),
  )
  await expect(
    auth.transport.request({
      operation: 'create',
      repo: effect.repo,
      webhookUrl: effect.webhookUrl,
      secret: effect.secret,
      events: effect.events,
    }),
  ).rejects.toMatchObject({ code: 'rate_limited' })
  const next = await resolveOperatorGitHubAuth(
    { ...options, descriptorId: beta.id, workspaceId: 'beta' },
    deps,
  )
  const before = deps.fetch.mock.calls.length
  await expect(
    next.transport.request({ operation: 'list', repo: effect.repo }),
  ).rejects.toMatchObject({ code: 'rate_limited' })
  expect(deps.fetch.mock.calls).toHaveLength(before)
})
it('retains a confirmed native deletion while marking its lost authority verification explicitly', async () => {
  const { auth, deps } = await fixture('app', 'active')
  const original = deps.fetch.getMockImplementation()!
  deps.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init)
    if (init?.method === 'DELETE')
      await env.EVENTS_DB.prepare(
        "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2)",
      ).run()
    return response
  })
  await auth.transport.request({ operation: 'delete', repo: effect.repo, hookId: 10 })
  expect(
    await env.EVENTS_DB.prepare(
      'SELECT state,verified,error_code,provider_status FROM github_hook_operations',
    ).first(),
  ).toMatchObject({
    state: 'accepted',
    verified: 0,
    error_code: 'authority_changed',
    provider_status: 204,
  })
  const before = deps.fetch.mock.calls.length
  await expect(
    auth.transport.request({ operation: 'ping', repo: effect.repo, hookId: 10 }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(deps.fetch.mock.calls).toHaveLength(before)
})
it('treats equivalent receiver URL spellings as one unresolved target', async () => {
  const { auth, deps } = await fixture('app', 'active')
  const original = deps.fetch.getMockImplementation()!
  let dispatches = 0
  deps.fetch.mockImplementation(async (url, init) => {
    if (String(url).includes('/repos/') && init?.method === 'POST') {
      dispatches++
      throw new Error('lost')
    }
    return original(url, init)
  })
  const request = {
    operation: 'create' as const,
    repo: effect.repo,
    webhookUrl: effect.webhookUrl,
    secret: effect.secret,
    events: effect.events,
  }
  await expect(auth.transport.request(request)).rejects.toMatchObject({ code: 'indeterminate' })
  await expect(
    auth.transport.request({ ...request, webhookUrl: effect.webhookUrl + '/' }),
  ).rejects.toMatchObject({ code: 'indeterminate' })
  expect(dispatches).toBe(1)
})
it('classifies explicit input and missing CLI failures without exposing private subprocess diagnostics', async () => {
  const { operatorGitHubExitCode } = await import('../../../../scripts/providers/github/auth')
  let invalid: unknown
  try {
    extractOperatorGitHubAuthArgs(['--github-auth', 'unknown'])
  } catch (error) {
    invalid = error
  }
  expect(operatorGitHubExitCode(invalid)).toBe(2)
  const auth = await resolveOperatorGitHubAuth(
    { mode: 'gh' },
    {
      runner: async () => {
        throw Object.assign(new Error('private-error-canary'), { code: 'ENOENT' })
      },
    },
  )
  let missing: unknown
  try {
    await auth.transport.request({ operation: 'list', repo: 'owner/repo' })
  } catch (error) {
    missing = error
  }
  expect(operatorGitHubExitCode(missing)).toBe(3)
  expect((missing as Error).message).not.toContain('private-error-canary')
})

it('reconciles an uncertain create using exact protected inputs and a fresh signed ping without replaying it', async () => {
  const { inspectGitHubHookOperations, reconcileGitHubHookOperation } =
    await import('../../../../scripts/providers/github/operation-recovery')
  const f = await fixture('app', 'active')
  const normal = f.fetcher.getMockImplementation()!
  let created = 0,
    pinged = false
  f.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (init?.method === 'POST' && path.endsWith('/hooks')) {
      created++
      throw new Error('lost-effect')
    }
    if (init?.method === 'GET' && path.endsWith('/hooks')) return Response.json([hook])
    if (path.endsWith('/pings')) pinged = true
    if (path.endsWith('/deliveries'))
      return Response.json(
        pinged
          ? [
              {
                guid: 'recovery-ping',
                event: 'ping',
                status_code: 200,
                delivered_at: new Date().toISOString(),
              },
            ]
          : [],
      )
    return normal(url, init)
  })
  const originalRequest = {
    operation: 'create' as const,
    repo: effect.repo,
    webhookUrl: effect.webhookUrl,
    secret: effect.secret,
    events: effect.events,
  }
  await expect(f.auth.transport.request(originalRequest)).rejects.toMatchObject({
    code: 'indeterminate',
  })
  await env.EVENTS_DB.exec('UPDATE github_hook_operations SET updated_at=updated_at-9000')
  const rows = await inspectGitHubHookOperations(query, f.auth, {})
  expect(rows.operations).toHaveLength(1)
  const row = rows.operations[0]!
  expect(JSON.stringify(rows)).not.toContain(effect.webhookUrl)
  const input = {
    operationId: row.id,
    expectedUpdatedAt: row.updatedAt,
    requestHash: row.requestHash,
    originalRequest,
    acknowledgeUncertainOutcome: true,
    observation: 'present' as const,
  }
  await expect(
    reconcileGitHubHookOperation(query, f.auth, {
      ...input,
      originalRequest: { ...originalRequest, secret: 'wrong-private-input' },
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  const result = await reconcileGitHubHookOperation(query, f.auth, input)
  expect(result.observation).toBe('present')
  expect(result.historicalState).toBe('indeterminate')
  expect(created).toBe(1)
  expect(pinged).toBe(true)
  expect((await inspectGitHubHookOperations(query, f.auth, {})).operations).toHaveLength(0)
  const original = await env.EVENTS_DB.prepare(
    'SELECT state FROM github_hook_operations WHERE id=?',
  )
    .bind(row.id)
    .first()
  expect(original?.state).toBe('indeterminate')
})

it('retains the unresolved intent when current observations or authority do not support recovery', async () => {
  const { inspectGitHubHookOperations, reconcileGitHubHookOperation } =
    await import('../../../../scripts/providers/github/operation-recovery')
  const f = await fixture('app', 'active')
  const normal = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (url, init) =>
    init?.method === 'DELETE' ? Promise.reject(new Error('lost-effect')) : normal(url, init),
  )
  const originalRequest = { operation: 'delete' as const, repo: effect.repo, hookId: 10 }
  await expect(f.auth.transport.request(originalRequest)).rejects.toMatchObject({
    code: 'indeterminate',
  })
  await env.EVENTS_DB.exec('UPDATE github_hook_operations SET updated_at=updated_at-9000')
  const row = (await inspectGitHubHookOperations(query, f.auth, {})).operations[0]!
  const input = {
    operationId: row.id,
    expectedUpdatedAt: row.updatedAt,
    requestHash: row.requestHash,
    originalRequest,
    acknowledgeUncertainOutcome: true,
    observation: 'absent' as const,
  }
  f.fetcher.mockImplementation(async (url, init) =>
    new URL(String(url)).pathname.endsWith('/hooks') ? Response.json([hook]) : normal(url, init),
  )
  await expect(reconcileGitHubHookOperation(query, f.auth, input)).rejects.toMatchObject({
    code: 'conflict',
  })
  expect((await inspectGitHubHookOperations(query, f.auth, {})).operations).toHaveLength(1)
  f.fetcher.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/hooks')) {
      await env.EVENTS_DB.exec(
        "UPDATE github_auth_descriptors SET revision=revision+1,metadata_json=json_set(metadata_json,'$.revision',revision+1)",
      )
      return Response.json([])
    }
    return normal(url, init)
  })
  await expect(reconcileGitHubHookOperation(query, f.auth, input)).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(
    await env.EVENTS_DB.prepare(
      'SELECT count(*) AS n FROM github_hook_operation_reconciliations',
    ).first('n'),
  ).toBe(0)
})

it('requires an explicit uncertainty acknowledgement and a completed local deadline before recording absence', async () => {
  const { inspectGitHubHookOperations, reconcileGitHubHookOperation } =
    await import('../../../../scripts/providers/github/operation-recovery')
  const f = await fixture('token', 'legacy')
  const normal = f.fetcher.getMockImplementation()!
  let deletes = 0
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') {
      deletes++
      throw new Error('lost-effect')
    }
    return normal(url, init)
  })
  const originalRequest = { operation: 'delete' as const, repo: effect.repo, hookId: 10 }
  await expect(f.auth.transport.request(originalRequest)).rejects.toMatchObject({
    code: 'indeterminate',
  })
  let row = (await inspectGitHubHookOperations(query, f.auth, {})).operations[0]!
  let input = {
    operationId: row.id,
    expectedUpdatedAt: row.updatedAt,
    requestHash: row.requestHash,
    originalRequest,
    acknowledgeUncertainOutcome: true,
    observation: 'absent' as const,
  }
  await expect(reconcileGitHubHookOperation(query, f.auth, input)).rejects.toMatchObject({
    code: 'conflict',
  })
  await env.EVENTS_DB.exec('UPDATE github_hook_operations SET updated_at=updated_at-9000')
  row = (await inspectGitHubHookOperations(query, f.auth, {})).operations[0]!
  input = { ...input, expectedUpdatedAt: row.updatedAt }
  await expect(
    reconcileGitHubHookOperation(query, f.auth, { ...input, acknowledgeUncertainOutcome: false }),
  ).rejects.toMatchObject({ code: 'validation' })
  expect((await reconcileGitHubHookOperation(query, f.auth, input)).observation).toBe('absent')
  expect(deletes).toBe(1)
  expect(
    (await inspectGitHubHookOperations(query, f.auth, { all: true })).operations[0]
      ?.historicalState,
  ).toBe('indeterminate')
  f.fetcher.mockImplementation(normal)
  await f.auth.transport.request(originalRequest)
  expect(
    await env.EVENTS_DB.prepare(
      "SELECT count(*) AS n FROM github_hook_operations WHERE state='accepted'",
    ).first('n'),
  ).toBe(1)
})
it('requires absence of an updated hook ID as well as its original URL', async () => {
  const { inspectGitHubHookOperations, reconcileGitHubHookOperation } =
    await import('../../../../scripts/providers/github/operation-recovery')
  const f = await fixture('app', 'active')
  const normal = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') throw new Error('lost-effect')
    if (new URL(String(url)).pathname.endsWith('/hooks'))
      return Response.json([
        {
          ...hook,
          config: { ...hook.config, url: 'https://other.example/hook/github/another-private-slug' },
        },
      ])
    return normal(url, init)
  })
  const originalRequest = { ...effect, operation: 'update' as const, active: true }
  await expect(f.auth.transport.request(originalRequest)).rejects.toMatchObject({
    code: 'indeterminate',
  })
  await env.EVENTS_DB.exec('UPDATE github_hook_operations SET updated_at=updated_at-9000')
  const row = (await inspectGitHubHookOperations(query, f.auth, {})).operations[0]!
  await expect(
    reconcileGitHubHookOperation(query, f.auth, {
      operationId: row.id,
      expectedUpdatedAt: row.updatedAt,
      requestHash: row.requestHash,
      originalRequest,
      acknowledgeUncertainOutcome: true,
      observation: 'absent',
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('keeps an unknown effect blocked across a reviewed repository rename by numeric identity', async () => {
  const f = await fixture('app', 'active')
  const normal = f.fetcher.getMockImplementation()!
  let attempts = 0,
    renamed = false,
    verifiedPing = false
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && new URL(String(url)).pathname.endsWith('/hooks')) {
      attempts++
      throw new Error('lost-effect')
    }
    if (renamed && new URL(String(url)).pathname.endsWith('/pings')) {
      verifiedPing = true
      return new Response(null, { status: 204 })
    }
    if (renamed && new URL(String(url)).pathname.endsWith('/deliveries'))
      return Response.json(
        verifiedPing
          ? [
              {
                guid: 'renamed-recovery-ping',
                event: 'ping',
                status_code: 200,
                delivered_at: new Date().toISOString(),
              },
            ]
          : [],
      )
    if (renamed && new URL(String(url)).pathname.endsWith('/hooks')) return Response.json([hook])
    if (renamed && new URL(String(url)).pathname.endsWith('/access_tokens'))
      return Response.json({
        token: 'synthetic-renamed-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
        repositories: [{ id: 101, full_name: 'owner/renamed', private: true, owner: { id: 50 } }],
      })
    return normal(url, init)
  })
  const original = {
    operation: 'create' as const,
    repo: effect.repo,
    webhookUrl: effect.webhookUrl,
    secret: effect.secret,
    events: effect.events,
  }
  await expect(f.auth.transport.request(original)).rejects.toMatchObject({ code: 'indeterminate' })
  await env.EVENTS_DB.exec(
    "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2,'$.repositories[0].fullName','owner/renamed')",
  )
  renamed = true
  const auth = await resolveOperatorGitHubAuth(f.options, f.deps)
  await expect(
    auth.transport.request({ ...original, repo: 'owner/renamed' }),
  ).rejects.toMatchObject({ code: 'indeterminate' })
  expect(attempts).toBe(1)
  const { inspectGitHubHookOperations, reconcileGitHubHookOperation } =
    await import('../../../../scripts/providers/github/operation-recovery')
  await env.EVENTS_DB.exec('UPDATE github_hook_operations SET updated_at=updated_at-9000')
  const row = (await inspectGitHubHookOperations(query, auth, {})).operations[0]!
  const recovered = await reconcileGitHubHookOperation(query, auth, {
    operationId: row.id,
    expectedUpdatedAt: row.updatedAt,
    requestHash: row.requestHash,
    originalRequest: original,
    acknowledgeUncertainOutcome: true,
    observation: 'present',
  })
  expect(recovered.observation).toBe('present')
  expect(attempts).toBe(1)
  expect(verifiedPing).toBe(true)
})

it('uses bounded cursor pagination for delivery history without page parameters', async () => {
 const f=await fixture('app','active');const normal=f.fetcher.getMockImplementation()!;const cursors:(string|null)[]=[];
 f.fetcher.mockImplementation(async (input,init)=>{
  const url=new URL(String(input));if(!url.pathname.endsWith('/deliveries'))return normal(input,init);
  expect(url.searchParams.has('page')).toBe(false);const cursor=url.searchParams.get('cursor');cursors.push(cursor);
  return Response.json(cursor?[{id:2}]:[{id:1}],cursor?{}:{headers:{link:'<https://api.github.com/repos/owner/repo/hooks/10/deliveries?per_page=100&cursor=opaque_123>; rel="next"'}});
 });
 expect(await f.auth.transport.request({operation:'deliveries',repo:effect.repo,hookId:10})).toEqual([{id:1},{id:2}]);expect(cursors).toEqual([null,'opaque_123']);
});
it.each([
 'https://other.invalid/repos/owner/repo/hooks/10/deliveries?cursor=next',
 'https://api.github.com/repos/other/repo/hooks/10/deliveries?cursor=next',
 'https://api.github.com/repos/owner/repo/hooks/11/deliveries?cursor=next',
 'https://api.github.com/repos/owner/repo/hooks/10/deliveries?page=2',
 'https://api.github.com/repos/owner/repo/hooks/10/deliveries?cursor=next&private=value',
])('rejects untrusted delivery pagination without sending another hook request: %s',async(next)=>{
 const f=await fixture('app','active');const normal=f.fetcher.getMockImplementation()!;let requests=0;
 f.fetcher.mockImplementation(async(input,init)=>{if(new URL(String(input)).pathname.endsWith('/deliveries')){requests++;return Response.json([{id:1}],{headers:{link:'<'+next+'>; rel="next"'}})}return normal(input,init)});
 await expect(f.auth.transport.request({operation:'deliveries',repo:effect.repo,hookId:10})).rejects.toMatchObject({code:'unavailable'});expect(requests).toBe(1);
});
it('rejects repeated delivery cursors instead of looping or returning partial history',async()=>{
 const f=await fixture('app','active');const normal=f.fetcher.getMockImplementation()!;let requests=0;
 f.fetcher.mockImplementation(async(input,init)=>{if(new URL(String(input)).pathname.endsWith('/deliveries')){requests++;return Response.json([{id:requests}],{headers:{link:'<https://api.github.com/repos/owner/repo/hooks/10/deliveries?cursor=repeated>; rel="next"'}})}return normal(input,init)});
 await expect(f.auth.transport.request({operation:'deliveries',repo:effect.repo,hookId:10})).rejects.toMatchObject({code:'unavailable'});expect(requests).toBe(2);
});
it('retains safe token-scope diagnostics on a journaled write rejected before dispatch',async()=>{
 const f=await fixture('app','active');await f.auth.verifyRepositoryAuthority!(effect.repo);const normal=f.fetcher.getMockImplementation()!;let dispatched=0;
 f.fetcher.mockImplementation(async(input,init)=>{const path=new URL(String(input)).pathname;if(path.endsWith('/access_tokens'))return new Response('private-provider-body-canary',{status:422});if(path.endsWith('/pings'))dispatched++;return normal(input,init)});
 await expect(f.auth.transport.request({operation:'ping',repo:effect.repo,hookId:10})).rejects.toMatchObject({code:'denied',operationId:expect.any(String),providerStage:'installation_token',providerStatus:422,message:expect.stringContaining('repository selection and App permissions')});expect(dispatched).toBe(0);
 const rows=await query<{state:string;provider_status:number|null;error_code:string}>({sql:'SELECT state,provider_status,error_code FROM github_hook_operations',params:[]});expect(rows).toEqual([{state:'rejected',provider_status:null,error_code:'denied'}]);
});

it('uses the same validated cursor traversal in explicit gh mode',async()=>{
 const f=await fixture('gh','active');const cursors:(string|null)[]=[];
 f.runner.mockImplementation(async(_command,args)=>{const path=args[args.indexOf('--method')+2]!;const url=new URL(path,'https://api.github.com/');cursors.push(url.searchParams.get('cursor'));expect(args).toContain('--include');expect(url.searchParams.has('page')).toBe(false);return url.searchParams.has('cursor')?'HTTP/2.0 200 OK\r\n\r\n[{"id":2}]':'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/repos/owner/repo/hooks/10/deliveries?cursor=opaque>; rel="next"\r\n\r\n[{"id":1}]'});
 expect(await f.auth.transport.request({operation:'deliveries',repo:effect.repo,hookId:10})).toEqual([{id:1},{id:2}]);expect(cursors).toEqual([null,'opaque']);
});
it('refuses cursor history beyond its page budget without returning partial results',async()=>{
 const f=await fixture('app','active');const normal=f.fetcher.getMockImplementation()!;let requests=0;
 f.fetcher.mockImplementation(async(input,init)=>{if(new URL(String(input)).pathname.endsWith('/deliveries')){requests++;return Response.json([{id:requests}],{headers:{link:'<https://api.github.com/repos/owner/repo/hooks/10/deliveries?cursor=page_'+requests+'>; rel="next"'}})}return normal(input,init)});
 await expect(f.auth.transport.request({operation:'deliveries',repo:effect.repo,hookId:10})).rejects.toMatchObject({code:'unavailable'});expect(requests).toBe(3);
});

it('uses the remaining overall gh deadline and refuses late page results', async () => {
  const f = await fixture('gh', 'active')
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  const timeouts: number[] = []
  f.runner.mockImplementation(async (_command, args, options) => {
    timeouts.push((options as { timeoutMs: number }).timeoutMs)
    const cursor = new URL(args[args.indexOf('--method') + 2]!, 'https://api.github.com/').searchParams.get('cursor')
    elapsed += cursor ? 4000 : 5000
    return cursor
      ? 'HTTP/2.0 200 OK\r\n\r\n[{"id":2}]'
      : 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/repos/owner/repo/hooks/10/deliveries?cursor=opaque>; rel="next"\r\n\r\n[{"id":1}]'
  })
  try {
    await expect(f.auth.transport.request({ operation: 'deliveries', repo: effect.repo, hookId: 10 })).rejects.toMatchObject({ code: 'unavailable' })
    expect(timeouts).toEqual([8000, 3000])
  } finally { clock.mockRestore() }
})
