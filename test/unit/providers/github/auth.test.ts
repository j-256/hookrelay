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
it('retains a confirmed native deletion while marking its lost authority verification explicitly',async () => {
  const {auth,deps}=await fixture('app','active')
  const original=deps.fetch.getMockImplementation()!
  deps.fetch.mockImplementation(async (url,init)=>{
    const response=await original(url,init)
    if(init?.method==='DELETE')await env.EVENTS_DB.prepare("UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2)").run()
    return response
  })
  await auth.transport.request({operation:'delete',repo:effect.repo,hookId:10})
  expect(await env.EVENTS_DB.prepare('SELECT state,verified,error_code,provider_status FROM github_hook_operations').first()).toMatchObject({state:'accepted',verified:0,error_code:'authority_changed',provider_status:204})
  const before=deps.fetch.mock.calls.length
  await expect(auth.transport.request({operation:'ping',repo:effect.repo,hookId:10})).rejects.toMatchObject({code:'conflict'})
  expect(deps.fetch.mock.calls).toHaveLength(before)
})
it('treats equivalent receiver URL spellings as one unresolved target',async () => {
  const {auth,deps}=await fixture('app','active')
  const original=deps.fetch.getMockImplementation()!
  let dispatches=0
  deps.fetch.mockImplementation(async (url,init)=>{if(String(url).includes('/repos/') && init?.method==='POST'){dispatches++;throw new Error('lost')}return original(url,init)})
  const request={operation:'create' as const,repo:effect.repo,webhookUrl:effect.webhookUrl,secret:effect.secret,events:effect.events}
  await expect(auth.transport.request(request)).rejects.toMatchObject({code:'indeterminate'})
  await expect(auth.transport.request({...request,webhookUrl:effect.webhookUrl+'/'})).rejects.toMatchObject({code:'indeterminate'})
  expect(dispatches).toBe(1)
})
it('classifies explicit input and missing CLI failures without exposing private subprocess diagnostics',async () => {
  const {operatorGitHubExitCode}=await import('../../../../scripts/providers/github/auth')
  let invalid:unknown
  try{extractOperatorGitHubAuthArgs(['--github-auth','unknown'])}catch(error){invalid=error}
  expect(operatorGitHubExitCode(invalid)).toBe(2)
  const auth=await resolveOperatorGitHubAuth({mode:'gh'},{runner:async ()=>{throw Object.assign(new Error('private-error-canary'),{code:'ENOENT'})}})
  let missing:unknown
  try{await auth.transport.request({operation:'list',repo:'owner/repo'})}catch(error){missing=error}
  expect(operatorGitHubExitCode(missing)).toBe(3)
  expect((missing as Error).message).not.toContain('private-error-canary')
})
