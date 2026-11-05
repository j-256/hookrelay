import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import worker, { type Env } from '../../src/index'
import type { Subscription } from '../../src/types'
import github from '../../src/adapters/github'
import { acceptConfigurationChange, configurationQuery, readConfigurationState } from '../../src/configuration/authority'
import { sealHandoffBundle } from '../../src/lib/github-handoff-crypto'
import { readHandoffSigningSecret } from '../../src/lib/github-handoff-store'
import { hashSubscriptionSlug } from '../../src/lib/subscription'
import { hmacSha256Hex } from '../../src/lib/hmac'

const repositoryId = '2fdf499e-49af-4a22-b438-8abe1d2cf579'
const resourceId = '52d5cc8e-5c91-48ed-8556-d83f086f3960'
const bundle = {
  version: 1 as const,
  hmac: { name: 'HMAC_GITHUB_OWNER_REPO', value: 'synthetic-auth-secret' },
  slugs: { activity: 'synthetic-activity-credential-route', stars: 'synthetic-stars-credential-route', alerts: 'synthetic-alerts-credential-route' },
}
const keyring = JSON.stringify({ version: 1, activeKeyId: 'primary', keys: [{ id: 'primary', key: btoa('k'.repeat(32)) }] })
const runtime = new Proxy(env, { get(target, prop, receiver) {
  return prop === 'HOOK_HANDOFF_KEYS' ? keyring : Reflect.get(target, prop, receiver)
} }) as Env
let sub: Subscription
beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec("DELETE FROM github_handoff_receivers; DELETE FROM github_handoff_repositories; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;")
  const query = configurationQuery(env.EVENTS_DB)
  const state = await readConfigurationState(query)
  const binding = { authorityId: state.authorityId, workspaceId: 'alpha', repositoryId, repository: 'Owner/Repo', revision: 1 }
  const encrypted = await sealHandoffBundle(runtime, binding, bundle)
  await env.EVENTS_DB.prepare('INSERT INTO github_handoff_repositories(id,authority_id,workspace_id,repository_key,repository,bundle_revision,encrypted_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind(repositoryId, state.authorityId, 'alpha', 'owner/repo', 'Owner/Repo', 1, JSON.stringify(encrypted), new Date().toISOString()).run()
  await env.EVENTS_DB.prepare('INSERT INTO github_handoff_receivers(resource_id,repository_id,profile,auth_mode,created_at) VALUES(?,?,?,?,?)')
    .bind(resourceId, repositoryId, 'activity', 'bundle', new Date().toISOString()).run()
  sub = { name: 'github:Owner/Repo', source: 'github', enabled: true, sinks: [],
    auth: { scheme: 'github-sha256', secretEnv: 'HOOK_HANDOFF_KEYS', credentialId: repositoryId },
    githubHandoff: { authorityId: state.authorityId, workspaceId: 'alpha', repositoryId, resourceId, repository: 'Owner/Repo', profile: 'activity' },
  }
  await acceptConfigurationChange(query, { clientId: 'operator', clientRevision: 1, workspaceId: 'alpha', actorId: 'owner',
    authorityId: state.authorityId, expectedRevision: 0, kind: 'migration', operationId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), deletes: [], puts: [{ namespace: 'SUBS', key: `sub:sha256:${await hashSubscriptionSlug(bundle.slugs.activity)}`, resourceId, value: JSON.stringify(sub) }],
  })
})
it('resolves only the exact workspace and resource credential association', async () => {
  await expect(readHandoffSigningSecret(runtime, sub)).resolves.toBe('synthetic-auth-secret')
  await expect(readHandoffSigningSecret(runtime, { ...sub, githubHandoff: { ...sub.githubHandoff!, workspaceId: 'beta' } })).rejects.toThrow('unavailable')
})
it('validates the body with the repository HMAC rather than its wrapping key', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: 'owner/repo' } }))
  const signature = await hmacSha256Hex('synthetic-auth-secret', body)
  const request = new Request('https://hooks.example/', { headers: { 'x-hub-signature-256': `sha256=${signature}` } })
  await expect(github.verify(request, body, sub, runtime)).resolves.toBeUndefined()
  const wrong = new Request('https://hooks.example/', { headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex(keyring, body)}` } })
  await expect(github.verify(wrong, body, sub, runtime)).rejects.toThrow('signature mismatch')
})
it('rejects a signed event for another repository before it can be persisted', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: 'other/repo' } }))
  const request = new Request('https://hooks.example/', { headers: { 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID() } })
  await expect(github.parse(request, body, sub)).rejects.toThrow('repository mismatch')
})
it('never uses a reserved wrapping keyring as a primary or alternate legacy HMAC', async () => {
  const body = new TextEncoder().encode('{}')
  const request = new Request('https://hooks.example/', { headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex(keyring, body)}` } })
  for (const auth of [
    { scheme: 'github-sha256', secretEnv: 'HOOK_HANDOFF_KEYS' },
    { scheme: 'github-sha256', secretEnv: 'LEGACY_MISSING_SECRET', alternateSecretEnvs: ['HOOK_HANDOFF_KEYS'] },
    { scheme: 'github-sha256', secretEnv: 'HOOK_HANDOFF_KEYS', credentialId: '' },
  ]) await expect(github.verify(request, body, { ...sub, auth }, runtime)).rejects.toThrow('unavailable')
})
it('reports unavailable custody as 503 rather than rejecting a valid signature as 401', async () => {
  const unavailable = new Proxy(runtime, { get(target, prop, receiver) {
    return prop === 'HOOK_HANDOFF_KEYS' ? undefined : Reflect.get(target, prop, receiver)
  } })
  const body = JSON.stringify({ repository: { full_name: 'Owner/Repo' } })
  const signature = await hmacSha256Hex('synthetic-auth-secret', new TextEncoder().encode(body))
  const response = await worker.fetch(new Request(`https://hooks.example/hook/github/${bundle.slugs.activity}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}`, 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID() }, body,
  }), unavailable, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext)
  expect(response.status).toBe(503)
})
