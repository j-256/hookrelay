import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker, { type Env } from '../../src/index'
import { acceptConfigurationChange, configurationQuery, readConfigurationState, readRuntimeConfiguration } from '../../src/configuration/authority'
import { managementTokenHash } from '../../src/management/access'
import { MANAGEMENT_PATH } from '../../src/management/contract'
import { CONFIGURATION_LIMITS } from '../../src/configuration/authority'
import { pruneConfigurationReviews } from '../../src/management/configuration'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const TOKEN = `hkr_${'d'.repeat(43)}`
const PRIVATE = 'synthetic-private-authority-value'
const SLUG = `configuration-${'b'.repeat(22)}`
const SUB_KEY = await subscriptionKvKeyForSlug(SLUG)
const RESOURCE = '00000000-0000-4000-8000-000000000003'
const SINK_ID = '00000000-0000-4000-8000-000000000004'
const context = { workspaceId: 'workspace', actorId: 'owner' }
const policy = { enabled: true, sinks: ['phone'], filter: null, sinkFilters: {} }
const query = configurationQuery(env.EVENTS_DB)
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
let runtime: Env
let queue: ReturnType<typeof recordingQueue>
let credential: {
  id: string; revision: number; tokenHash: string; expiresAt: string;
  workspaceIds: string[]; capabilities: ('read' | 'retry' | 'configure')[];
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM configuration_policy_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM deliveries; DELETE FROM events; UPDATE configuration_authority SET revision = 0, mode = \'legacy\', operation_id = NULL, pending_change = NULL;')
  credential = {
    id: 'hq', revision: 1, tokenHash: await managementTokenHash(TOKEN),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    workspaceIds: [context.workspaceId], capabilities: ['read', 'retry', 'configure'],
  }
  queue = recordingQueue()
  runtime = new Proxy(withDeliveryQueue(env, queue.binding), {
    get(target, property, receiver) {
      if (property === 'MANAGEMENT_CREDENTIALS') return JSON.stringify([credential])
      if (property === 'CONFIGURATION_TEST_SECRET') return PRIVATE
      return Reflect.get(target, property, receiver)
    },
  })
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, {
    clientId: 'operator', clientRevision: 1, ...context, authorityId: state.authorityId,
    operationId: crypto.randomUUID(), expectedRevision: 0, kind: 'migration', resourceId: null,
    expiresAt: new Date(Date.now() + 60000).toISOString(), deletes: [],
    puts: [
      { namespace: 'SUBS', key: SUB_KEY, resourceId: RESOURCE, value: JSON.stringify({
        name: 'example', source: 'github', enabled: true, sinks: ['phone'],
        auth: { scheme: 'github-sha256', secretEnv: 'CONFIGURATION_TEST_SECRET' }, fallbackUrl: `https://private.example/${PRIVATE}`,
      }) },
      { namespace: 'SINKS', key: 'sink:phone', resourceId: SINK_ID, value: JSON.stringify({ type: 'ntfy', topic: PRIVATE }) },
    ],
  })
})

async function call(command: string, input: Record<string, unknown> = {}, target = runtime) {
  return worker.fetch(new Request(`https://hooks.example${MANAGEMENT_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, input: { ...context, ...input } }),
  }), target, ctx)
}

async function result(command: string, input: Record<string, unknown> = {}) {
  const response = await call(command, input)
  expect(response.status).toBe(200)
  const body = await response.json() as { result: Record<string, unknown>; capabilities: string[] }
  expect(JSON.stringify(body)).not.toContain(PRIVATE)
  expect(JSON.stringify(body)).not.toContain(SUB_KEY)
  expect(JSON.stringify(body)).not.toContain('CONFIGURATION_TEST_SECRET')
  expect(body.capabilities).toEqual(credential.capabilities.filter(value => value !== 'configure'))
  return body.result
}

async function review(overrides: Record<string, unknown> = {}) {
  const state = await readConfigurationState(query)
  return result('configuration_policy_plan', {
    planId: crypto.randomUUID(), authorityId: state.authorityId, revision: state.revision,
    resourceId: RESOURCE, policy: { ...policy, enabled: false }, ...overrides,
  })
}

describe('reviewed provider policy management', () => {
  it('returns bounded secret-free metadata with stable IDs and preserves the legacy response contract', async () => {
    expect(await result('configuration')).toMatchObject({ mode: 'active', revision: 1, canConfigure: true, supported: { create: false, retire: false } })
    expect(await result('configuration_subscription', { resourceId: RESOURCE })).toMatchObject({ resourceId: RESOURCE, policy })
    expect(await result('configuration_subscriptions', { revision: 1 })).toMatchObject({ items: [{ resourceId: RESOURCE, name: 'example', policy }], nextCursor: null })
    expect(await result('configuration_sinks', { revision: 1 })).toMatchObject({ items: [{ resourceId: SINK_ID, name: 'phone', type: 'ntfy', retired: false }] })
    expect(await result('subscriptions')).toMatchObject({ items: [{ name: 'example', source: 'github', enabled: true, sinks: ['phone'] }] })
  })

  it('changes actual ingress only after apply and does not alter accepted delivery decisions', async () => {
    await env.EVENTS_DB.prepare(`INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key)
      VALUES ('existing', '2026-01-01T00:00:00.000Z', 'redacted', 'example', 'github', 'push', 'Synthetic', 'synthetic')`).run()
    await env.EVENTS_DB.prepare(`INSERT INTO deliveries (event_id, sink_name, generation, status, attempts, created_at, updated_at)
      VALUES ('existing', 'phone', 2, 'queued', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run()
    const deliveries = await env.EVENTS_DB.prepare('SELECT * FROM deliveries').all()
    const plan = await review()
    expect(plan).toMatchObject({ status: 'ready', before: policy, after: { ...policy, enabled: false }, receipt: null })
    expect(JSON.parse((await readRuntimeConfiguration(env, 'SUBS', SUB_KEY))!).enabled).toBe(true)
    const applied = await result('configuration_policy_apply', { planId: plan.planId })
    expect(applied).toMatchObject({ status: 'accepted', effect: 'future-ingress-policy', receipt: { operationId: plan.planId, revision: 2 } })
    expect((await worker.fetch(new Request(`https://hooks.example/hook/github/${SLUG}`, { method: 'POST', body: '{}' }), runtime, ctx)).status).toBe(204)
    expect((await env.EVENTS_DB.prepare('SELECT * FROM deliveries').all()).results).toEqual(deliveries.results)
    expect(queue.messages).toEqual([])
    expect(await result('configuration_policy_get', { planId: plan.planId })).toEqual(applied)
    expect(await result('configuration_policy_apply', { planId: plan.planId })).toEqual(applied)
    expect(await readConfigurationState(query)).toMatchObject({ revision: 2 })
    expect(await result('subscriptions')).toMatchObject({ items: [{ enabled: false }] })
  })

  it('preserves authentication and private provider fields when changing filters', async () => {
    const plan = await review({ policy: { ...policy, filter: { eventTypes: { include: ['push'] } } } })
    await result('configuration_policy_apply', { planId: plan.planId })
    const value = JSON.parse((await readRuntimeConfiguration(env, 'SUBS', SUB_KEY))!)
    expect(value).toMatchObject({ auth: { secretEnv: 'CONFIGURATION_TEST_SECRET' }, fallbackUrl: `https://private.example/${PRIVATE}`, filter: { eventTypes: { include: ['push'] } } })
    const response = await worker.fetch(new Request(`https://hooks.example/hook/github/${SLUG}`, {
      method: 'POST', body: '{}', headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=wrong' },
    }), runtime, ctx)
    expect(response.status).toBe(401)
    expect(queue.messages).toEqual([])
    const raw = new TextEncoder().encode(JSON.stringify({ hook_id: 1, repository: { full_name: 'synthetic/example' } }))
    const signature = await hmacSha256Hex(PRIVATE, raw)
    const accepted = await worker.fetch(new Request(`https://hooks.example/hook/github/${SLUG}`, {
      method: 'POST', body: raw, headers: {
        'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'configuration-synthetic-ping',
        'x-hub-signature-256': `sha256=${signature}`,
      },
    }), runtime, ctx)
    expect(accepted.status).toBe(200)
    expect(queue.messages).toEqual([])
    expect((await env.EVENTS_DB.prepare('SELECT decision_reason FROM deliveries WHERE event_id = ?').bind('github:configuration-synthetic-ping').first())?.decision_reason).toBe('source-record-only')
  })

  it('requires configure authority and rechecks actor, workspace and credential revision', async () => {
    const plan = await review()
    credential.capabilities = ['read', 'retry']
    expect(await result('configuration')).toMatchObject({ canConfigure: false })
    expect((await call('configuration_policy_apply', { planId: plan.planId })).status).toBe(403)
    credential.capabilities.push('configure')
    for (const changed of [{ workspaceId: 'other' }, { actorId: 'other' }]) {
      expect((await call('configuration_policy_get', { planId: plan.planId, ...changed })).status).toBe(404)
      expect((await call('configuration_policy_apply', { planId: plan.planId, ...changed })).status).toBe(404)
    }
    credential.revision += 1
    expect((await call('configuration_policy_apply', { planId: plan.planId })).status).toBe(404)
    credential.expiresAt = '2020-01-01T00:00:00.000Z'
    expect((await call('configuration_policy_apply', { planId: plan.planId })).status).toBe(401)
    expect(await readConfigurationState(query)).toMatchObject({ revision: 1 })
  })

  it('rejects stale plans and pagination, expired reviews, duplicate-ID changes and unknown destinations', async () => {
    const first = await review()
    const second = await review({ policy: { ...policy, sinks: [] } })
    const state = await readConfigurationState(query)
    expect((await call('configuration_policy_plan', {
      planId: first.planId, authorityId: state.authorityId, revision: state.revision, resourceId: RESOURCE, policy,
    })).status).toBe(409)
    expect((await call('configuration_policy_plan', {
      planId: crypto.randomUUID(), authorityId: state.authorityId, revision: state.revision, resourceId: RESOURCE,
      policy: { ...policy, sinks: ['missing'] },
    })).status).toBe(400)
    await result('configuration_policy_apply', { planId: first.planId })
    expect((await call('configuration_policy_apply', { planId: second.planId })).status).toBe(409)
    expect((await call('configuration_subscriptions', { revision: 1 })).status).toBe(409)
    const expired = await review({ policy })
    await env.EVENTS_DB.prepare('UPDATE configuration_policy_reviews SET expires_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', expired.planId).run()
    expect((await call('configuration_policy_apply', { planId: expired.planId })).status).toBe(409)
    expect(await result('configuration_policy_get', { planId: expired.planId })).toMatchObject({ status: 'expired' })
  })

  it('keeps retired destinations unavailable for enabling and does not accept credential input', async () => {
    await env.EVENTS_DB.prepare('UPDATE configuration_entries SET retired = 1 WHERE resource_id = ?').bind(SINK_ID).run()
    const state = await readConfigurationState(query)
    const input = { planId: crypto.randomUUID(), authorityId: state.authorityId, revision: state.revision, resourceId: RESOURCE }
    expect((await call('configuration_policy_plan', { ...input, policy: { ...policy, filter: { eventTypes: { include: ['push'] } } } })).status).toBe(400)
    expect((await call('configuration_policy_plan', { ...input, policy: { ...policy, auth: PRIVATE } })).status).toBe(400)
    const plan = await review()
    expect(plan.status).toBe('ready')
  })

  it('bounds pending reviews and prunes only expired retained metadata in batches', async () => {
    for (let index = 0; index < CONFIGURATION_LIMITS.PENDING_REVIEWS; index += 1) await review()
    const state = await readConfigurationState(query)
    expect((await call('configuration_policy_plan', {
      planId: crypto.randomUUID(), authorityId: state.authorityId, revision: state.revision,
      resourceId: RESOURCE, policy: { ...policy, enabled: false },
    })).status).toBe(409)
    expect((await call('configuration_policy_plan', {
      planId: crypto.randomUUID(), authorityId: state.authorityId, revision: state.revision,
      actorId: 'another-actor', resourceId: RESOURCE, policy: { ...policy, enabled: false },
    })).status).toBe(409)
    const expired = await env.EVENTS_DB.prepare('SELECT id FROM configuration_policy_reviews LIMIT 1').first<{ id: string }>()
    await env.EVENTS_DB.prepare('UPDATE configuration_policy_reviews SET expires_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', expired!.id).run()
    await pruneConfigurationReviews(runtime)
    expect((await call('configuration_policy_get', { planId: expired!.id })).status).toBe(404)
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_policy_reviews').first())?.count).toBe(CONFIGURATION_LIMITS.PENDING_REVIEWS - 1)
  })

  it('reports the activation boundary without pretending policy writes are available', async () => {
    await env.EVENTS_DB.exec("UPDATE configuration_authority SET mode = 'legacy'")
    expect(await result('configuration')).toMatchObject({ mode: 'legacy', canConfigure: false })
    expect((await call('configuration_subscription', { resourceId: RESOURCE })).status).toBe(409)
  })

  it('paginates stable IDs without overlapping pages and detects legacy cursor revision drift', async () => {
    for (let index = 0; index < CONFIGURATION_LIMITS.PAGE_SIZE; index += 1) {
      await env.EVENTS_DB.prepare(`INSERT INTO configuration_entries (namespace, entry_key, resource_id, value)
        SELECT 'SUBS', ?, ?, value FROM configuration_entries WHERE resource_id = ?`)
        .bind(`sub:sha256:${index.toString(16).padStart(64, '0')}`, crypto.randomUUID(), RESOURCE).run()
    }
    const first = await result('configuration_subscriptions', { revision: 1 })
    const second = await result('configuration_subscriptions', { revision: 1, cursor: first.nextCursor })
    const firstItems = first.items as { resourceId: string }[]
    const secondItems = second.items as { resourceId: string }[]
    expect(firstItems).toHaveLength(CONFIGURATION_LIMITS.PAGE_SIZE)
    expect(secondItems).toHaveLength(1)
    expect(new Set([...firstItems, ...secondItems].map(entry => entry.resourceId)).size).toBe(CONFIGURATION_LIMITS.PAGE_SIZE + 1)
    expect(second.nextCursor).toBeNull()
    const legacy = await result('subscriptions')
    const plan = await review()
    await result('configuration_policy_apply', { planId: plan.planId })
    expect((await call('subscriptions', { cursor: legacy.nextCursor })).status).toBe(409)
  })

  it('retains acceptance receipts while their reviews remain available', async () => {
    const plan = await review()
    await result('configuration_policy_apply', { planId: plan.planId })
    await env.EVENTS_DB.prepare('UPDATE configuration_receipts SET accepted_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', plan.planId).run()
    await pruneConfigurationReviews(runtime)
    expect(await result('configuration_policy_get', { planId: plan.planId })).toMatchObject({ status: 'accepted' })
    await env.EVENTS_DB.prepare('UPDATE configuration_policy_reviews SET expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', plan.planId).run()
    await pruneConfigurationReviews(runtime)
    expect((await env.EVENTS_DB.prepare('SELECT id FROM configuration_receipts WHERE id = ?').bind(plan.planId).first())).toBeNull()
  })

  it('never reports a conflicting review when acceptance raced the first receipt read', async () => {
    const plan = await review()
    let raced = false
    const database = new Proxy(env.EVENTS_DB, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql)
          if (!sql.startsWith('SELECT authority_id AS authorityId')) return statement
          return { bind: (...params: unknown[]) => ({ all: async () => {
            if (!raced) {
              raced = true
              await result('configuration_policy_apply', { planId: plan.planId })
            }
            return statement.bind(...params).all()
          } }) }
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const racing = new Proxy(runtime, {
      get(target, key, receiver) { return key === 'EVENTS_DB' ? database : Reflect.get(target, key, receiver) },
    })
    const response = await call('configuration_policy_get', { planId: plan.planId }, racing)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { status: 'accepted', receipt: { revision: 2 } } })
    expect(raced).toBe(true)
  })
})
