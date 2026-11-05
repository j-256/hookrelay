import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import worker, { type Env } from '../../src/index'
import { acceptConfigurationChange, configurationQuery, readConfigurationState } from '../../src/configuration/authority'
import { managementTokenHash } from '../../src/management/access'
import { hashSubscriptionSlug } from '../../src/lib/subscription'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'
import * as handoffOperations from '../../src/management/github-handoff'

const token = `hkr_${'h'.repeat(43)}`
const context = { workspaceId: 'alpha', actorId: 'owner' }
const keyring = JSON.stringify({ version: 1, activeKeyId: 'primary', keys: [{ id: 'primary', key: btoa('k'.repeat(32)) }] })
const query = configurationQuery(env.EVENTS_DB)
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
let capabilities: string[]
let keys: string | undefined
let runtime: Env
beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec("DELETE FROM github_handoff_reviews; DELETE FROM github_handoff_receivers; DELETE FROM github_handoff_repositories; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM deliveries; DELETE FROM events; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;")
  capabilities = ['read', 'handoff', 'custody']
  keys = keyring
  const credential = { id: 'handoff-client', revision: 1, tokenHash: await managementTokenHash(token), expiresAt: new Date(Date.now() + 3600000).toISOString(), workspaceIds: ['alpha', 'beta'] }
  runtime = new Proxy(withDeliveryQueue(env, recordingQueue().binding), { get(target, prop, receiver) {
    if (prop === 'MANAGEMENT_CREDENTIALS') return JSON.stringify([{ ...credential, capabilities }])
    if (prop === 'HOOK_HANDOFF_KEYS') return keys
    if (prop === 'HOOK_SETUP_ORIGIN') return 'https://hooks.example'
    if (prop === 'HOOK_SETUP_KEY' || prop === 'HOOK_SETUP_GITHUB_TOKEN') return undefined
    if (prop === 'HMAC_GITHUB_OWNER_REPO') return 'synthetic-legacy-secret'
    return Reflect.get(target, prop, receiver)
  } })
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, { ...context, clientId: 'operator', clientRevision: 1, authorityId: state.authorityId, expectedRevision: 0,
    kind: 'migration', operationId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString(), deletes: [],
    puts: [{ namespace: 'SINKS', key: 'sink:discord:repo-activity', resourceId: crypto.randomUUID(), value: JSON.stringify({ type: 'discord', urlEnv: 'SYNTHETIC_DISCORD_URL' }) }],
  })
})
async function call(command: string, fields: Record<string, unknown> = {}, who = context) {
  return worker.fetch(new Request('https://hooks.example/admin/api/v1', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, input: { ...who, ...fields } }) }), runtime, ctx)
}
async function metadata(command: string, fields: Record<string, unknown> = {}) {
  const response = await call(command, fields)
  const body = await response.json() as any
  expect(response.status, JSON.stringify(body)).toBe(200)
  expect(JSON.stringify(body)).not.toContain('/hook/github/')
  expect(JSON.stringify(body)).not.toContain('synthetic-legacy-secret')
  expect(JSON.stringify(body)).not.toContain('ciphertext')
  return body.result
}
async function privateCall(action: string, fields: Record<string, unknown>, who = context) {
  return worker.fetch(new Request('https://hooks.example/admin/api/v1/private/github-handoff', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, input: { ...who, ...fields } }) }), runtime, ctx)
}
async function plan(profile = 'activity', repository = 'Owner/Repo', planId = crypto.randomUUID()) {
  const state = await readConfigurationState(query)
  return metadata('github_handoff_plan', { planId, authorityId: state.authorityId, revision: state.revision, repository, profile, sinks: ['discord:repo-activity'] })
}
it('creates one receiver without automatic installer credentials and privately retrieves its details', async () => {
  expect((await metadata('github_handoff_configuration')).canCreate).toBe(true)
  const reviewed = await plan()
  expect(reviewed.status).toBe('ready')
  const applied = await metadata('github_handoff_apply', { planId: reviewed.planId })
  expect(applied.routingConfigured).toBe(true)
  const response = await privateCall('reveal', { resourceId: applied.resourceId })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const details = await response.json() as any
  expect(details.repository).toBe('Owner/Repo')
  expect(details.events).toEqual(['push', 'workflow_run', 'pull_request'])
  const body = JSON.stringify({ repository: { full_name: 'owner/repo' } })
  const signature = await hmacSha256Hex(details.secret, new TextEncoder().encode(body))
  const ping = await worker.fetch(new Request(details.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}`, 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID() }, body }), runtime, ctx)
  expect(ping.status).toBe(200)
  const status = await metadata('github_handoff_status', { resourceId: applied.resourceId })
  expect(status.pingAt).not.toBeNull()
  expect(status.deliveredAt).toBeNull()
  const stored = await env.EVENTS_DB.prepare('SELECT encrypted_json FROM github_handoff_repositories').all<{ encrypted_json: string }>()
  expect(JSON.stringify(stored.results)).not.toContain(details.secret)
  expect(JSON.stringify(stored.results)).not.toContain(new URL(details.url).pathname.split('/').at(-1))
})
it('replays apply without replacing credentials and gives later profiles the same signing value', async () => {
  const first = await plan()
  const accepted = await metadata('github_handoff_apply', { planId: first.planId })
  const initial = await (await privateCall('reveal', { resourceId: accepted.resourceId })).json() as any
  expect((await metadata('github_handoff_apply', { planId: first.planId })).resourceId).toBe(accepted.resourceId)
  const second = await plan('stars', 'owner/repo')
  const stars = await metadata('github_handoff_apply', { planId: second.planId })
  const detail = await (await privateCall('reveal', { resourceId: stars.resourceId })).json() as any
  expect(detail.secret).toBe(initial.secret)
  expect(detail.url).not.toBe(initial.url)
  expect(detail.events).toEqual(['star'])
  expect((await (await privateCall('export', { repositoryId: accepted.repositoryId })).json() as any).record.profiles).toEqual(['activity', 'stars'])
})
it('denies private reads through another allowed workspace or without custody grants', async () => {
  const first = await plan()
  const accepted = await metadata('github_handoff_apply', { planId: first.planId })
  expect((await privateCall('reveal', { resourceId: accepted.resourceId }, { ...context, workspaceId: 'beta' })).status).toBe(404)
  capabilities = ['read', 'handoff']
  expect((await privateCall('reveal', { resourceId: accepted.resourceId })).status).toBe(403)
})
it('preserves legacy activity credentials while adopting it and adding a new profile', async () => {
  const legacy = { name: 'github:Owner/Repo', source: 'github', enabled: true, sinks: ['discord:repo-activity'], auth: { scheme: 'github-sha256', secretEnv: 'HMAC_GITHUB_OWNER_REPO' }, filter: { eventTypes: { include: ['push.created'] } } }
  const slugs = { activity: 'synthetic-legacy-activity-route', stars: 'synthetic-legacy-stars-route', alerts: 'synthetic-legacy-alerts-route' }
  const resourceId = crypto.randomUUID()
  const state = await readConfigurationState(query)
  const key = `sub:sha256:${await hashSubscriptionSlug(slugs.activity)}`
  await acceptConfigurationChange(query, { ...context, clientId: 'operator', clientRevision: 1, authorityId: state.authorityId, expectedRevision: state.revision,
    kind: 'lifecycle', operationId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString(), deletes: [], puts: [{ namespace: 'SUBS', key, resourceId, value: JSON.stringify(legacy) }],
  })
  const latest = await readConfigurationState(query)
  const response = await privateCall('adopt_plan', { planId: crypto.randomUUID(), authorityId: latest.authorityId, revision: latest.revision, repository: 'Owner/Repo', record: { hmac: { name: 'HMAC_GITHUB_OWNER_REPO', value: 'synthetic-legacy-secret' }, slugs, profiles: ['activity'], state: 'active' } })
  expect(response.status).toBe(200)
  const adoption = await response.json() as any
  await metadata('github_handoff_apply', { planId: adoption.planId })
  const after = await env.EVENTS_DB.prepare('SELECT resource_id,value FROM configuration_entries WHERE entry_key=?').bind(key).first<{ resource_id: string; value: string }>()
  expect(after!.resource_id).toBe(resourceId)
  const value = JSON.parse(after!.value)
  expect(value.auth).toEqual(legacy.auth)
  expect(value.filter).toEqual(legacy.filter)
  const next = await plan('alerts')
  const accepted = await metadata('github_handoff_apply', { planId: next.planId })
  const details = await (await privateCall('reveal', { resourceId: accepted.resourceId })).json() as any
  expect(details.secret).toBe('synthetic-legacy-secret')
  expect(details.events).toEqual(['code_scanning_alert', 'dependabot_alert', 'secret_scanning_alert'])
})
it('retains routing after a lost apply response and returns the original receipt', async () => {
  const first = await plan()
  await metadata('github_handoff_apply', { planId: first.planId })
  await env.EVENTS_DB.prepare("UPDATE github_handoff_reviews SET state='ready' WHERE id=?").bind(first.planId).run()
  const recovered = await metadata('github_handoff_get', { planId: first.planId })
  expect(recovered.routingConfigured).toBe(true)
  expect(recovered.status).toBe('configured')
})
it('does not provision an expired or stale review and reports unavailable storage honestly', async () => {
  const first = await plan()
  await env.EVENTS_DB.prepare("UPDATE github_handoff_reviews SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(first.planId).run()
  expect((await call('github_handoff_apply', { planId: first.planId })).status).toBe(409)
  keys = undefined
  const availability = await metadata('github_handoff_configuration')
  expect(availability.canCreate).toBe(false)
  expect(availability.reason).toBe('provider_setup_required')
})
it('accepts only one concurrent first creation for case aliases of a repository', async () => {
  const first = await plan('activity', 'Owner/Repo')
  const second = await plan('activity', 'owner/repo')
  const responses = await Promise.all([call('github_handoff_apply', { planId: first.planId }), call('github_handoff_apply', { planId: second.planId })])
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  expect((await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_handoff_repositories').first<{ n: number }>())!.n).toBe(1)
})
it('keeps an accepted receiver visible while reporting unavailable encrypted credentials', async () => {
  const first = await plan()
  const accepted = await metadata('github_handoff_apply', { planId: first.planId })
  await env.EVENTS_DB.prepare('UPDATE github_handoff_repositories SET encrypted_json=? WHERE id=?').bind('{}', accepted.repositoryId).run()
  const status = await metadata('github_handoff_status', { resourceId: accepted.resourceId })
  expect(status.routingConfigured).toBe(true)
  expect(status.credentialAvailable).toBe(false)
  expect((await privateCall('reveal', { resourceId: accepted.resourceId })).status).toBe(503)
})
it('restricts a stars receiver to star notifications even when the sender selects other events', async () => {
  const reviewed = await plan('stars')
  const applied = await metadata('github_handoff_apply', { planId: reviewed.planId })
  const row = await env.EVENTS_DB.prepare('SELECT value FROM configuration_entries WHERE resource_id=?').bind(applied.resourceId).first<{ value: string }>()
  expect(JSON.parse(row!.value).filter).toEqual({ eventTypes: { include: ['star.*'] } })
})
it('rejects noncanonical wrapping keys in the readiness result', async () => {
  const bad = btoa('k'.repeat(32)).slice(0, -2) + 'B='
  keys = JSON.stringify({ version: 1, activeKeyId: 'primary', keys: [{ id: 'primary', key: bad }] })
  const configuration = await metadata('github_handoff_configuration')
  expect(configuration.canCreate).toBe(false)
  expect(configuration.reason).toBe('provider_setup_required')
})
it('does not report active routing when the provider authority is in legacy mode', async () => {
  const first = await plan()
  const accepted = await metadata('github_handoff_apply', { planId: first.planId })
  await env.EVENTS_DB.prepare("UPDATE configuration_authority SET mode='legacy'").run()
  expect((await metadata('github_handoff_status', { resourceId: accepted.resourceId })).routingConfigured).toBe(false)
})
it('prunes expired review and access history while retaining immutable credential recovery', async () => {
  const first = await plan()
  const accepted = await metadata('github_handoff_apply', { planId: first.planId })
  await privateCall('reveal', { resourceId: accepted.resourceId })
  await env.EVENTS_DB.exec("UPDATE github_handoff_reviews SET expires_at='2000-01-01T00:00:00.000Z'; UPDATE github_handoff_access SET created_at='2000-01-01T00:00:00.000Z';")
  await handoffOperations.pruneHandoffHistory(env)
  expect((await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_handoff_reviews').first<{ n: number }>())!.n).toBe(0)
  expect((await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_handoff_access').first<{ n: number }>())!.n).toBe(0)
  expect((await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_handoff_repositories').first<{ n: number }>())!.n).toBe(1)
})
it('reports malformed repository page URLs as validation failures', async () => {
  const state = await readConfigurationState(query)
  const response = await call('github_handoff_plan', { planId: crypto.randomUUID(), authorityId: state.authorityId,
    revision: state.revision, repository: 'https://github.com/Owner/Repo/issues', profile: 'activity', sinks: ['discord:repo-activity'] })
  expect(response.status).toBe(400)
})
