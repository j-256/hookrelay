import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  configurationQuery,
  readConfigurationState,
  acceptConfigurationChange,
} from '../../src/configuration/authority'
import { planGitHubSetup, applyGitHubSetup } from '../../src/management/github-setup'
import { githubAppKeyFingerprint } from '../../src/lib/github-app-token'
import { githubTokenFingerprint } from '../../src/lib/github-auth'
import type { Env } from '../../src/index'
const query = configurationQuery(env.EVENTS_DB)
const context = { workspaceId: 'alpha', actorId: 'operator' }
const principal = {
  id: 'legacy-client',
  revision: 1,
  tokenHash: 'a'.repeat(64),
  expiresAt: '2099-01-01T00:00:00.000Z',
  workspaceIds: ['alpha'],
  capabilities: ['read', 'provision'] as ['read', 'provision'],
}
const setupKey = 'synthetic-receiver-setup-root-1234567890123456'
let privateKey: string, fingerprint: string
const legacyReceipt = z
  .object({
    planId: z.uuid(),
    resourceId: z.uuid(),
    name: z.string(),
    repository: z.string(),
    events: z.array(z.string()),
    sinks: z.array(z.string()),
    action: z.enum(['create', 'install']),
    status: z.literal('installed'),
    errorCode: z.enum(['github_rejected', 'github_unavailable', 'github_limited']).nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
    updatedAt: z.string(),
    routingConfigured: z.boolean(),
    webhookInstalled: z.boolean(),
    webhookId: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((value) => value.webhookInstalled === (value.status === 'installed'))
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
    "DELETE FROM github_setup_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns; UPDATE github_auth_runtime_policy SET mode='registry',revision=1; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;",
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
        value: JSON.stringify({ type: 'ntfy', topic: 'synthetic' }),
      },
    ],
  })
})
afterEach(() => vi.restoreAllMocks())
it.each(['app', 'token'] as const)(
  'accepts old-HQ-shaped setup under registry %s without exposing new credentials or changing receiver custody',
  async (mode) => {
    const token = 'synthetic-compatible-manual-token'
    const repository = { id: 101, fullName: 'owner/repo', ownerId: 50, private: true }
    const descriptor = {
      id: 'provider',
      revision: 1,
      keyRevision: 1,
      mode,
      ...(mode === 'app'
        ? {
            appId: 42,
            installationId: 7,
            accountId: 50,
            keySecretName: 'GITHUB_APP_COMPAT',
            fingerprint,
          }
        : {
            tokenSecretName: 'GITHUB_TOKEN_COMPAT',
            fingerprint: await githubTokenFingerprint(token),
          }),
      repositories: [repository],
      managementWorkspaces: ['alpha'],
      capabilities: ['repository-hooks-write'],
      state: 'active',
    }
    await env.EVENTS_DB.prepare(
      'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
    )
      .bind(descriptor.id, JSON.stringify(descriptor), crypto.randomUUID())
      .run()
    const values: Record<string, unknown> = {
      HOOK_SETUP_KEY: setupKey,
      HOOK_SETUP_ORIGIN: 'https://hooks.example',
      GITHUB_APP_COMPAT: privateKey,
      GITHUB_TOKEN_COMPAT: token,
      MANAGEMENT_CREDENTIALS: JSON.stringify([principal]),
    }
    const runtime = new Proxy(env, {
      get(target, prop, receiver) {
        return typeof prop === 'string' && prop in values
          ? values[prop]
          : Reflect.get(target, prop, receiver)
      },
    }) as Env
    let creates = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/app/installations/7')
        return Response.json({
          id: 7,
          app_id: 42,
          account: { id: 50 },
          permissions: { repository_hooks: 'write' },
          suspended_at: null,
        })
      if (path.endsWith('/access_tokens'))
        return Response.json({
          token: 'synthetic-compatible-app-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: JSON.parse(String(init?.body)).permissions,
          repositories: [{ id: 101, full_name: 'owner/repo', owner: { id: 50 }, private: true }],
        })
      if (path === '/repos/owner/repo')
        return Response.json({ id: 101, full_name: 'owner/repo', owner: { id: 50 }, private: true })
      expect(path).toBe('/repos/owner/repo/hooks')
      if (init?.method === 'POST') {
        creates++
        const body = JSON.parse(String(init.body))
        delete body.config.secret
        return Response.json({ ...body, id: 42 }, { status: 201 })
      }
      return Response.json([])
    })
    const state = await readConfigurationState(query)
    const plan = await planGitHubSetup(runtime, principal, {
      ...context,
      planId: crypto.randomUUID(),
      authorityId: state.authorityId,
      revision: state.revision,
      resourceId: null,
      name: 'compatible-receiver',
      repository: 'owner/repo',
      events: ['push'],
      sinks: ['phone'],
    })
    const applied = await applyGitHubSetup(runtime, principal, { ...context, planId: plan.planId })
    expect(legacyReceipt.safeParse(applied).success).toBe(true)
    expect(JSON.stringify(applied)).not.toMatch(/PRIVATE KEY|synthetic-compatible|\/hook\/github\//)
    const before = await env.EVENTS_DB.prepare(
      "SELECT value FROM configuration_entries WHERE namespace='SUBS' AND resource_id=?",
    )
      .bind(applied.resourceId)
      .first('value')
    expect(typeof before).toBe('string')
    await env.EVENTS_DB.exec(
      "UPDATE github_auth_descriptors SET revision=revision+1,key_revision=key_revision+1,metadata_json=json_set(metadata_json,'$.revision',revision+1,'$.keyRevision',key_revision+1,'$.state','disconnected')",
    )
    expect(
      await env.EVENTS_DB.prepare(
        "SELECT value FROM configuration_entries WHERE namespace='SUBS' AND resource_id=?",
      )
        .bind(applied.resourceId)
        .first('value'),
    ).toBe(before)
    expect(creates).toBe(1)
  },
)
