import { applyD1Migrations, createExecutionContext, createMessageBatch, env } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import worker, { type Env } from '../../src/index'
import {
  configurationQuery,
  readConfigurationState,
  acceptConfigurationChange,
} from '../../src/configuration/authority'
import {
  prepareGitHubAuthCandidate,
  activateGitHubAuthCandidate,
} from '../../src/configuration/github-auth'
import {
  createGitHubAppKeyChallenge,
  handleGitHubAppKeyVerification,
  GITHUB_APP_KEY_VERIFICATION_PATH,
} from '../../src/management/github-app-key-verification'
import {
  planGitHubSetup,
  applyGitHubSetup,
  getGitHubSetup,
} from '../../src/management/github-setup'
import { disconnectGitHubAppDescriptor } from '../../scripts/providers/github/app-deployment'
import { githubAppKeyFingerprint } from '../../src/lib/github-app-token'
import { resolveGitHubAuth, githubTokenFingerprint } from '../../src/lib/github-auth'
import type { GitHubAuthDescriptor } from '../../src/lib/github-app-contract'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { DELIVERY_QUEUE_NAME } from '../../src/delivery'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'
import issue from '../fixtures/github/issues-opened.json'
const query = configurationQuery(env.EVENTS_DB)
const context = { workspaceId: 'alpha', actorId: 'operator' }
const principal = {
  id: 'workflow-client',
  revision: 1,
  tokenHash: 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00.000Z',
  workspaceIds: ['alpha'],
  capabilities: ['read', 'provision'] as ['read', 'provision'],
}
const target = { accountId: 'a'.repeat(32), workerName: 'synthetic-worker' }
let keys: { privateKey: string; fingerprint: string }[] = []
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  for (let i = 0; i < 2; i++) {
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
    const privateKey = [
      '-----BEGIN PRIVATE KEY-----',
      btoa(String.fromCharCode(...bytes)),
      '-----END PRIVATE KEY-----',
    ].join('\n')
    keys.push({ privateKey, fingerprint: await githubAppKeyFingerprint(privateKey) })
  }
})
beforeEach(async () => {
  await env.EVENTS_DB.exec(
    "DELETE FROM deliveries; DELETE FROM events; DELETE FROM github_setup_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns; UPDATE github_auth_runtime_policy SET mode='legacy',revision=1; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;",
  )
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
        value: JSON.stringify({ type: 'ntfy', topic: 'synthetic-workflow' }),
      },
    ],
  })
})
afterEach(() => vi.restoreAllMocks())
async function fixture() {
  const queue = recordingQueue()
  const values: Record<string, unknown> = {
    HOOK_SETUP_KEY: 'synthetic-setup-root-key-12345678901234567890',
    HOOK_SETUP_ORIGIN: 'https://hooks.example',
    GITHUB_APP_WORKFLOW_A: keys[0]!.privateKey,
    MANAGEMENT_CREDENTIALS: JSON.stringify([principal]),
    CF_VERSION_METADATA: { id: 'version-a', tag: '', timestamp: '' },
  }
  const runtime = withDeliveryQueue(
    new Proxy(env, {
      get(target, prop, receiver) {
        return typeof prop === 'string' && prop in values
          ? values[prop]
          : Reflect.get(target, prop, receiver)
      },
    }) as Env,
    queue.binding,
  )
  const descriptor: GitHubAuthDescriptor = {
    id: 'workflow',
    revision: 1,
    keyRevision: 1,
    mode: 'app',
    appId: 42,
    installationId: 7,
    accountId: 50,
    keySecretName: 'GITHUB_APP_WORKFLOW_A',
    fingerprint: keys[0]!.fingerprint,
    repositories: [{ id: 101, fullName: 'owner/repo', ownerId: 50, private: true }],
    managementWorkspaces: ['alpha'],
    capabilities: ['repository-hooks-write'],
    state: 'active',
  }
  const hooks: any[] = []
  const state = { creates: 0, mints: 0, notifications: 0, lost: false }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    if (url.origin === 'https://ntfy.sh') {
      state.notifications++
      return new Response('ok')
    }
    expect(url.origin).toBe('https://api.github.com')
    if (url.pathname === '/app/installations/7')
      return Response.json({
        id: 7,
        app_id: 42,
        account: { id: 50 },
        permissions: { repository_hooks: 'write' },
        suspended_at: null,
      })
    if (url.pathname.endsWith('/access_tokens')) {
      state.mints++
      const body = JSON.parse(String(init?.body))
      return Response.json({
        token: 'synthetic-workflow-app-token-' + state.mints,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: body.permissions,
        repositories: [{ id: 101, full_name: 'owner/repo', owner: { id: 50 }, private: true }],
      })
    }
    if (url.pathname === '/repos/owner/repo')
      return Response.json({ id: 101, full_name: 'owner/repo', owner: { id: 50 }, private: true })
    expect(url.pathname).toBe('/repos/owner/repo/hooks')
    if (init?.method === 'POST') {
      state.creates++
      const body = JSON.parse(String(init.body))
      hooks.push({ ...body, id: state.creates })
      if (state.lost) throw new Error('lost-effect')
      const publicHook = { ...hooks.at(-1), config: { ...body.config } }
      delete publicHook.config.secret
      return Response.json(publicHook, { status: 201 })
    }
    return Response.json(hooks.map((h) => ({ ...h, config: { ...h.config, secret: undefined } })))
  })
  async function activate(next: GitHubAuthDescriptor, expectedRevision: number, versionId: string) {
    values.CF_VERSION_METADATA = { id: versionId, tag: '', timestamp: '' }
    const candidate = await prepareGitHubAuthCandidate(query, {
      descriptor: next,
      expectedRevision,
      target,
    })
    await env.EVENTS_DB.prepare(
      "UPDATE github_auth_candidates SET state='deployed',version_id=? WHERE id=?",
    )
      .bind(versionId, candidate.id)
      .run()
    const challenge = await createGitHubAppKeyChallenge(query, candidate.id, versionId)
    const response = await handleGitHubAppKeyVerification(
      new Request('https://hooks.example' + GITHUB_APP_KEY_VERIFICATION_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: challenge.nonce }),
      }),
      runtime,
    )
    expect(response.status).toBe(200)
    const proof = (await response.json()) as { attestationId: string }
    return activateGitHubAuthCandidate(query, {
      candidateId: candidate.id,
      attestationId: proof.attestationId,
      verifyDeployment: async () => ({ ...target, versionId, singleVersion: true }),
    })
  }
  async function plan(name: string) {
    const configuration = await readConfigurationState(query)
    return planGitHubSetup(runtime, principal, {
      ...context,
      planId: crypto.randomUUID(),
      authorityId: configuration.authorityId,
      revision: configuration.revision,
      resourceId: null,
      name,
      repository: 'owner/repo',
      events: ['issues'],
      sinks: ['phone'],
    })
  }
  async function ingress(hook: any, type: string, id: string, valid = true) {
    const raw = new TextEncoder().encode(
      JSON.stringify(
        type === 'ping' ? { hook_id: hook.id, repository: { full_name: 'owner/repo' } } : issue,
      ),
    )
    const signature = await hmacSha256Hex(
      valid ? hook.config.secret : 'synthetic-wrong-secret',
      raw,
    )
    return worker.fetch(
      new Request(hook.config.url, {
        method: 'POST',
        body: raw,
        headers: {
          'content-type': 'application/json',
          'x-github-event': type,
          'x-github-delivery': id,
          'x-hub-signature-256': 'sha256=' + signature,
        },
      }),
      runtime,
      createExecutionContext(),
    )
  }
  return { queue, values, runtime, descriptor, hooks, state, activate, plan, ingress }
}
it('keeps verified activation, hook installation, signed ingress and notification delivery as separate outcomes across rotation and token adoption', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  const plan = await f.plan('workflow-receiver')
  expect(
    (await applyGitHubSetup(f.runtime, principal, { ...context, planId: plan.planId })).status,
  ).toBe('installed')
  expect(f.state.creates).toBe(1)
  expect(f.state.notifications).toBe(0)
  const hook = f.hooks[0]!
  expect((await f.ingress(hook, 'issues', 'invalid-signature', false)).status).toBe(401)
  expect((await f.ingress(hook, 'ping', 'workflow-ping')).status).toBe(200)
  expect(f.queue.messages).toHaveLength(0)
  expect((await f.ingress(hook, 'issues', 'workflow-issue')).status).toBe(200)
  expect(f.queue.messages).toHaveLength(1)
  expect(f.state.notifications).toBe(0)
  await worker.queue(
    createMessageBatch(DELIVERY_QUEUE_NAME, [
      { id: 'workflow-delivery', timestamp: new Date(), attempts: 1, body: f.queue.messages[0]! },
    ]),
    f.runtime,
  )
  expect(f.state.notifications).toBe(1)
  const receiver = await env.EVENTS_DB.prepare(
    "SELECT value FROM configuration_entries WHERE namespace='SUBS' AND resource_id=?",
  )
    .bind(plan.resourceId)
    .first('value')
  f.values.GITHUB_APP_WORKFLOW_B = keys[1]!.privateKey
  await f.activate(
    {
      ...f.descriptor,
      revision: 2,
      keyRevision: 2,
      keySecretName: 'GITHUB_APP_WORKFLOW_B',
      fingerprint: keys[1]!.fingerprint,
    } as GitHubAuthDescriptor,
    1,
    'version-b',
  )
  expect(
    await env.EVENTS_DB.prepare(
      "SELECT value FROM configuration_entries WHERE namespace='SUBS' AND resource_id=?",
    )
      .bind(plan.resourceId)
      .first('value'),
  ).toBe(receiver)
  await disconnectGitHubAppDescriptor(query, 'workflow', 2)
  await expect(f.plan('blocked-after-disconnect')).rejects.toThrow()
  expect((await f.ingress(hook, 'ping', 'disconnected-ping')).status).toBe(200)
  const token = 'synthetic-workflow-manual-token'
  f.values.GITHUB_MANUAL_WORKFLOW = token
  const { appId, installationId, accountId, keySecretName, ...common } = f.descriptor as Extract<
    GitHubAuthDescriptor,
    { mode: 'app' }
  >
  await f.activate(
    {
      ...common,
      mode: 'token',
      revision: 4,
      keyRevision: 3,
      tokenSecretName: 'GITHUB_MANUAL_WORKFLOW',
      fingerprint: await githubTokenFingerprint(token),
    },
    3,
    'version-token',
  )
  const manual = await f.plan('token-receiver')
  expect(
    (await applyGitHubSetup(f.runtime, principal, { ...context, planId: manual.planId })).status,
  ).toBe('installed')
  expect(f.state.creates).toBe(2)
})
it('reconciles an interrupted reviewed hook create without repeating the uncertain effect', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  const plan = await f.plan('uncertain-receiver')
  f.state.lost = true
  expect(
    (await applyGitHubSetup(f.runtime, principal, { ...context, planId: plan.planId })).status,
  ).toBe('indeterminate')
  await applyGitHubSetup(f.runtime, principal, { ...context, planId: plan.planId })
  expect(f.state.creates).toBe(1)
  expect(
    (await getGitHubSetup(f.runtime, principal, { ...context, planId: plan.planId })).status,
  ).toBe('installed')
  expect(f.state.creates).toBe(1)
})
it('reports bounded cold, warm and failed authority work without credentials or private receiver values', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  const diagnostics: any[] = []
  const input = {
    query,
    selection: { mode: 'app', descriptorId: 'workflow' },
    workspaceId: 'alpha',
    callerId: 'synthetic-operator',
    repositoryFullName: 'owner/repo',
    capability: 'repository-hooks-read' as const,
    phase: 'read' as const,
    loadPrivateKey: async () => keys[0]!.privateKey,
    diagnostic: (event: unknown) => diagnostics.push(event),
  }
  await resolveGitHubAuth(input as any)
  await resolveGitHubAuth(input as any)
  expect(diagnostics).toHaveLength(2)
  expect(diagnostics[0]).toMatchObject({
    mode: 'app',
    revision: 1,
    outcome: 'allowed',
    providerRequests: 2,
  })
  expect(diagnostics[1]).toMatchObject({ providerRequests: 0, outcome: 'allowed' })
  expect(diagnostics[0].d1Requests).toBeGreaterThan(0)
  expect(diagnostics[0].durationMs).toBeGreaterThanOrEqual(0)
  const safe = JSON.stringify(diagnostics)
  expect(safe).not.toMatch(/PRIVATE KEY|synthetic-workflow-app-token|\/hook\/github\//)
  await disconnectGitHubAppDescriptor(query, 'workflow', 1)
  await expect(resolveGitHubAuth(input as any)).rejects.toThrow()
  expect(diagnostics.at(-1).outcome).not.toBe('allowed')
  console.info(
    JSON.stringify({
      msg: 'github.workflow.synthetic-cost',
      cold: diagnostics[0],
      warm: diagnostics[1],
    }),
  )
})
it('prunes bounded resolved history while preserving unknown effects and the active registration receipt', async () => {
  const { pruneGitHubAuthHistory } = await import('../../src/configuration/github-auth')
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  const old = Date.now() - 31 * 86400000
  async function record(state: string, reconciled = false) {
    const id = crypto.randomUUID()
    await env.EVENTS_DB.prepare(
      "INSERT INTO github_hook_operations(id,descriptor_id,workspace_id,repository_id,operation,request_hash,target_hash,auth_fence_json,state,created_at,updated_at) VALUES (?,?,?,?,'create',?,?,'{}',?,?,?)",
    )
      .bind(id, 'workflow', 'alpha', 101, 'a'.repeat(64), 'b'.repeat(64), state, old, old)
      .run()
    if (reconciled)
      await env.EVENTS_DB.prepare(
        "INSERT INTO github_hook_operation_reconciliations(operation_id,observation,proof_json,auth_fence_json,observed_at,reconciled_at) VALUES (?,'absent','{}','{}',?,?)",
      )
        .bind(id, old, old)
        .run()
    return id
  }
  const unknown = await record('indeterminate')
  await record('accepted')
  await record('rejected')
  await record('indeterminate', true)
  const expired = await prepareGitHubAuthCandidate(query, {
    descriptor: { ...f.descriptor, id: 'expired' },
    expectedRevision: 0,
    target,
  })
  await env.EVENTS_DB.prepare(
    'UPDATE github_auth_candidates SET created_at=?,expires_at=? WHERE id=?',
  )
    .bind(old, old, expired.id)
    .run()
  const unknownCandidate = await prepareGitHubAuthCandidate(query, {
    descriptor: { ...f.descriptor, id: 'unknown-candidate' },
    expectedRevision: 0,
    target,
  })
  await env.EVENTS_DB.prepare(
    "INSERT INTO github_app_deployments(candidate_id,plan_json,phase,updated_at) VALUES (?,'{}','stage_indeterminate',?)",
  )
    .bind(unknownCandidate.id, old)
    .run()
  await env.EVENTS_DB.prepare(
    'UPDATE github_auth_candidates SET created_at=?,expires_at=? WHERE id=?',
  )
    .bind(old, old, unknownCandidate.id)
    .run()
  await env.EVENTS_DB.prepare(
    "UPDATE github_auth_candidates SET activated_at=? WHERE state='active'",
  )
    .bind(old)
    .run()
  await pruneGitHubAuthHistory(query)
  expect(
    await env.EVENTS_DB.prepare('SELECT id FROM github_auth_candidates WHERE id=?')
      .bind(unknownCandidate.id)
      .first('id'),
  ).toBe(unknownCandidate.id)
  expect(await env.EVENTS_DB.prepare('SELECT id FROM github_hook_operations').all()).toMatchObject({
    results: [{ id: unknown }],
  })
  expect(
    await env.EVENTS_DB.prepare(
      "SELECT count(*) AS n FROM github_auth_candidates WHERE state='active'",
    ).first('n'),
  ).toBe(1)
  expect(
    await env.EVENTS_DB.prepare('SELECT id FROM github_auth_candidates WHERE id=?')
      .bind(expired.id)
      .first(),
  ).toBe(null)
})
it('measures resource use for the complete synthetic management workflow', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  let d1 = 0
  f.values.EVENTS_DB = new Proxy(env.EVENTS_DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (sql: string) => {
          d1++
          return target.prepare(sql)
        }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const plan = await f.plan('cost-receiver')
  const planD1 = d1
  d1 = 0
  await applyGitHubSetup(f.runtime, principal, { ...context, planId: plan.planId })
  expect(planD1).toBeLessThanOrEqual(50)
  expect(d1).toBeLessThanOrEqual(50)
  expect(f.state.creates).toBe(1)
})

it('refuses a completion invalidated immediately after its authority CAS', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  let changed = false
  const raced: typeof query = async <Row>(statement: Parameters<typeof query>[0]) => {
    const rows = await query<Row>(statement)
    if (!changed && statement.sql.startsWith('UPDATE github_auth_authority SET generation')) {
      changed = true
      await invalidateGitHubAuthAuthority(query, 'workflow')
    }
    return rows
  }
  const { invalidateGitHubAuthAuthority } = await import('../../src/configuration/github-auth')
  await expect(
    resolveGitHubAuth({
      query: raced,
      selection: { mode: 'app', descriptorId: 'workflow' },
      workspaceId: 'alpha',
      callerId: 'synthetic-operator',
      repositoryFullName: 'owner/repo',
      capability: 'repository-hooks-write',
      phase: 'effect',
      loadPrivateKey: async () => keys[0]!.privateKey,
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(changed).toBe(true)
  expect(f.state.creates).toBe(0)
})
it('keeps a newly created authority row while verification is still pending', async () => {
  const f = await fixture()
  await f.activate(f.descriptor, 0, 'version-a')
  const { readGitHubAuthAuthority, pruneGitHubAuthHistory } =
    await import('../../src/configuration/github-auth')
  await readGitHubAuthAuthority(query, f.descriptor, 101, 'repository-hooks-write')
  await pruneGitHubAuthHistory(query)
  expect(
    await env.EVENTS_DB.prepare(
      'SELECT count(*) AS n FROM github_auth_authority WHERE descriptor_id=?',
    )
      .bind('workflow')
      .first('n'),
  ).toBe(1)
})
