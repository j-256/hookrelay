import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../../src/index'
import { managementTokenHash } from '../../src/management/access'
import { MANAGEMENT_LIMITS, MANAGEMENT_PATH, readManagementBody } from '../../src/management/contract'
import { pruneManagementReceipts } from '../../src/management/retry'
import type { planRetry } from '../../src/management/retry'
import type { readDeliveries, readDelivery, readSnapshot, readSubscriptions } from '../../src/management/read'
import { enqueuePendingDeliveries } from '../../src/delivery'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const TOKEN = `hkr_${'a'.repeat(43)}`
const PRIVATE = 'PRIVATE-PAYLOAD-AND-CREDENTIAL'
const EVENT = 'github:synthetic'
const TIMESTAMP = '2026-06-06T12:00:00.000Z'
const R2_KEY = 'events/synthetic.raw'
const SUB_KEY = `sub:sha256:${'a'.repeat(64)}`
const context = { workspaceId: 'workspace', actorId: 'owner' }
const delivery = { eventId: EVENT, sinkName: 'phone' }
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
let runtime: Env
let queue: ReturnType<typeof recordingQueue>
let credential: {
  id: string; revision: number; tokenHash: string; expiresAt: string;
  workspaceIds: string[]; capabilities: ('read' | 'retry')[];
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  vi.restoreAllMocks()
  await env.EVENTS_DB.exec('DELETE FROM management_retry_plans; DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM maintenance_state; DELETE FROM deliveries; DELETE FROM events;')
  for (const key of (await env.SUBS.list({ prefix: 'sub:' })).keys) await env.SUBS.delete(key.name)
  await env.SUBS.put(SUB_KEY, JSON.stringify({
    name: 'test', source: 'github', enabled: true, sinks: ['phone'],
    auth: { secretEnv: PRIVATE }, fallbackUrl: `https://private.example/${PRIVATE}`,
  }))
  await env.EVENTS_DB.prepare(
    `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, url, r2_key, fanout_results)
     VALUES (?, ?, ?, 'test', 'github', 'issues.opened', ?, ?, ?, ?)`,
  ).bind(EVENT, TIMESTAMP, 'a'.repeat(64), PRIVATE, `https://private.example/${PRIVATE}`, R2_KEY, PRIVATE).run()
  await env.EVENTS_DB.prepare(
    `INSERT INTO deliveries (event_id, sink_name, generation, status, attempts, last_error, created_at, updated_at)
     VALUES (?, 'phone', 4, 'exhausted', 8, ?, ?, ?)`,
  ).bind(EVENT, PRIVATE, TIMESTAMP, TIMESTAMP).run()
  await env.EVENTS_RAW.put('events/synthetic.json', JSON.stringify({ title: PRIVATE }))
  queue = recordingQueue()
  credential = {
    id: 'hq', revision: 1, tokenHash: await managementTokenHash(TOKEN),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    workspaceIds: [context.workspaceId], capabilities: ['read', 'retry'],
  }
  runtime = new Proxy(withDeliveryQueue(env, queue.binding), {
    get(target, property, receiver) {
      if (property === 'MANAGEMENT_CREDENTIALS') return JSON.stringify([credential])
      if (property === 'TEST_BYPASS_ACCESS') return '1'
      return Reflect.get(target, property, receiver)
    },
  })
})

async function call(command: string, input: Record<string, unknown> = {}, token = TOKEN, target = runtime) {
  return worker.fetch(new Request(`https://hooks.example${MANAGEMENT_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ command, input: { ...context, ...input } }),
  }), target, ctx)
}

type CommandResults = {
  snapshot: Awaited<ReturnType<typeof readSnapshot>>
  subscriptions: Awaited<ReturnType<typeof readSubscriptions>>
  deliveries: Awaited<ReturnType<typeof readDeliveries>>
  delivery: Awaited<ReturnType<typeof readDelivery>>
  retry_plan: Awaited<ReturnType<typeof planRetry>>
  retry_apply: Awaited<ReturnType<typeof planRetry>>
  retry_get: Awaited<ReturnType<typeof planRetry>>
}

async function result<K extends keyof CommandResults>(command: K, input: Record<string, unknown> = {}): Promise<CommandResults[K]> {
  const response = await call(command, input)
  expect(response.status).toBe(200)
  return (await response.json() as { version: number; result: CommandResults[K] }).result
}

async function plan(input: Record<string, unknown> = {}) {
  return result('retry_plan', {
    ...delivery, planId: crypto.randomUUID(), generation: 4, updatedAt: TIMESTAMP, ...input,
  })
}

describe('scoped management authentication and input', () => {
  it('rejects missing credentials before parsing the body and ignores the HTML test bypass', async () => {
    const response = await worker.fetch(new Request(`https://hooks.example${MANAGEMENT_PATH}`, {
      method: 'POST', body: PRIVATE,
    }), runtime, ctx)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(PRIVATE)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('rejects invalid, expired, malformed, and unconfigured credentials', async () => {
    expect((await call('snapshot', {}, `hkr_${'b'.repeat(43)}`)).status).toBe(401)
    credential.expiresAt = TIMESTAMP
    expect((await call('snapshot')).status).toBe(401)
    credential.revision = 0
    expect((await call('snapshot')).status).toBe(503)
    expect((await call('snapshot', {}, TOKEN, env)).status).toBe(503)
  })

  it('rejects cross-workspace access and retry without its dedicated capability', async () => {
    expect((await call('snapshot', { workspaceId: 'other' })).status).toBe(404)
    credential.capabilities = ['read']
    expect((await call('snapshot')).status).toBe(200)
    expect((await call('retry_plan', {
      ...delivery, planId: crypto.randomUUID(), generation: 4, updatedAt: TIMESTAMP,
    })).status).toBe(403)
    credential.capabilities = ['retry']
    expect((await call('snapshot')).status).toBe(403)
  })

  it('requires strict known commands, JSON, POST, and bounded input', async () => {
    expect((await call('snapshot', { sql: PRIVATE })).status).toBe(400)
    expect((await call('raw')).status).toBe(400)
    expect((await call('snapshot', { actorId: '../secret' })).status).toBe(400)
    const get = await worker.fetch(new Request(`https://hooks.example${MANAGEMENT_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }), runtime, ctx)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    for (const [body, contentType, expected] of [
      ['not JSON', 'application/json', 400],
      ['{}', 'text/plain', 415],
      [' '.repeat(MANAGEMENT_LIMITS.BODY_BYTES + 1), 'application/json', 413],
    ] as const) {
      const response = await worker.fetch(new Request(`https://hooks.example${MANAGEMENT_PATH}`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': contentType }, body,
      }), runtime, ctx)
      expect(response.status).toBe(expected)
    }
  })

  it('does not grant the management credential access to the HTML or raw handlers', async () => {
    const target = new Proxy(runtime, {
      get(value, property, receiver) {
        if (property === 'TEST_BYPASS_ACCESS') return undefined
        return Reflect.get(value, property, receiver)
      },
    })
    for (const path of ['/admin/events', `/admin/events/${EVENT}/raw`]) {
      const response = await worker.fetch(new Request(`https://hooks.example${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }), target, ctx)
      expect(response.status).toBe(403)
    }
  })
})

describe('management body deadline', () => {
  it('cancels stalled bodies at the input deadline', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    try {
      const body = new ReadableStream<Uint8Array>({ cancel })
      const request = new Request('https://hooks.example', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      const rejected = expect(readManagementBody(request)).rejects.toMatchObject({ code: 'request_timeout', status: 408 })
      await vi.advanceTimersByTimeAsync(MANAGEMENT_LIMITS.BODY_TIMEOUT_MS)
      await rejected
      expect(cancel).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})

describe('bounded, redacted metadata', () => {
  it('returns only the supported subscription and delivery metadata, without writing plans', async () => {
    for (const [command, input] of [
      ['subscriptions', {}], ['deliveries', {}], ['delivery', delivery], ['snapshot', {}],
    ] as const) {
      const response = await call(command, input)
      expect(response.status).toBe(200)
      const text = await response.text()
      for (const excluded of [PRIVATE, R2_KEY, 'a'.repeat(64), 'secretEnv', 'last_error', 'fanout_results']) {
        expect(text).not.toContain(excluded)
      }
    }
    expect(await result('subscriptions')).toMatchObject({
      items: [{ name: 'test', source: 'github', enabled: true, sinks: ['phone'] }], nextCursor: null,
    })
    expect(await result('delivery', delivery)).toMatchObject({ ...delivery, status: 'exhausted', generation: 4 })
    const count = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS n FROM management_retry_plans').first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it('fails safely on malformed metadata instead of treating it as an empty healthy provider', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({ name: PRIVATE }))
    const response = await call('subscriptions')
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain(PRIVATE)
    expect((await call('delivery', { ...delivery, sinkName: 'missing' })).status).toBe(404)
  })

  it('pages subscriptions without exposing KV keys or special runtime configuration', async () => {
    for (let index = 0; index < MANAGEMENT_LIMITS.PAGE_SIZE; index += 1) {
      await env.SUBS.put(`sub:sha256:${String(index).padStart(64, '0')}`, JSON.stringify({
        name: `subscription-${index}`, source: 'github', enabled: false, sinks: [], auth: PRIVATE,
      }))
    }
    await env.SUBS.put('management-test-special', PRIVATE)
    try {
      const first = await result('subscriptions')
      expect(first.items).toHaveLength(MANAGEMENT_LIMITS.PAGE_SIZE)
      expect(first.nextCursor).not.toBeNull()
      const second = await result('subscriptions', { cursor: first.nextCursor })
      expect(second.items).toHaveLength(1)
      expect(second.nextCursor).toBeNull()
      expect(JSON.stringify([...first.items, ...second.items])).not.toContain(PRIVATE)
      expect(JSON.stringify([...first.items, ...second.items])).not.toContain('sub:sha256:')
    } finally { await env.SUBS.delete('management-test-special') }
  })

  it('pages equal-timestamp deliveries deterministically and keeps advancing through filtered empty pages', async () => {
    await env.EVENTS_DB.batch(Array.from({ length: MANAGEMENT_LIMITS.PAGE_SIZE + 1 }, (_, index) =>
      env.EVENTS_DB.prepare(
        `INSERT INTO deliveries (event_id, sink_name, generation, status, attempts, created_at, updated_at)
         VALUES (?, ?, 1, 'queued', 0, ?, ?)`,
      ).bind(EVENT, `sink-${String(index).padStart(3, '0')}`, TIMESTAMP, TIMESTAMP),
    ))
    const first = await result('deliveries', { status: 'queued' })
    expect(first.items).toHaveLength(MANAGEMENT_LIMITS.PAGE_SIZE)
    expect(first.nextCursor).not.toBeNull()
    const second = await result('deliveries', { status: 'queued', cursor: first.nextCursor })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const names = [...first.items, ...second.items].map(row => row.sinkName)
    expect(new Set(names).size).toBe(names.length)
    const filtered = await result('deliveries', { status: 'queued', subscription: 'not-this-subscription' })
    expect(filtered.items).toHaveLength(0)
    expect(filtered.nextCursor).not.toBeNull()
    expect(filtered.scanned).toBe(MANAGEMENT_LIMITS.PAGE_SIZE)
  })

  it('caps health work and marks the retained delivery sample incomplete', async () => {
    await env.EVENTS_DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO deliveries (event_id, sink_name, generation, status, attempts, created_at, updated_at)
       SELECT ?, 'sample-' || i, 1, 'delivered', 1, ?, ? FROM n`,
    ).bind(MANAGEMENT_LIMITS.HEALTH_SAMPLE, EVENT, TIMESTAMP, TIMESTAMP).run()
    const snapshot = await result('snapshot')
    expect(snapshot.deliveries).toMatchObject({
      sampled: MANAGEMENT_LIMITS.HEALTH_SAMPLE, limit: MANAGEMENT_LIMITS.HEALTH_SAMPLE, truncated: true,
    })
    expect(Object.values(snapshot.deliveries.totals).reduce((sum: number, n) => sum + Number(n), 0)).toBe(MANAGEMENT_LIMITS.HEALTH_SAMPLE)
  })
})

describe('reviewed retry acceptance and recovery', () => {
  it('uses bounded index seeks for unfiltered and status-filtered continuation reads', async () => {
    for (const status of [null, 'queued']) {
      const explain = await env.EVENTS_DB.prepare(
        `EXPLAIN QUERY PLAN SELECT d.event_id, d.sink_name, e.sub_name
         FROM deliveries d JOIN events e ON e.id = d.event_id
         WHERE ${status ? 'd.status = ? AND' : ''} (d.updated_at, d.event_id, d.sink_name) < (?, ?, ?)
         ORDER BY d.updated_at DESC, d.event_id DESC, d.sink_name DESC LIMIT ?`,
      ).bind(...(status ? [status] : []), TIMESTAMP, EVENT, 'phone', MANAGEMENT_LIMITS.PAGE_SIZE + 1).all()
      const details = JSON.stringify(explain.results)
      expect(details).toContain(status ? 'deliveries_management_status_idx' : 'deliveries_management_updated_idx')
      expect(details).not.toContain('TEMP B-TREE')
      expect(details).not.toContain('SCAN d')
    }
  })

  it('binds a review to exact state and returns the same receipt without resending a later generation', async () => {
    const review = await plan()
    expect(review.state).toBe('review')
    const accepted = await result('retry_apply', { planId: review.planId })
    expect(accepted).toMatchObject({ state: 'accepted', acceptedGeneration: 5 })
    expect(queue.messages).toEqual([{ version: 1, ...delivery, generation: 6 }])
    expect(await result('retry_apply', { planId: review.planId })).toEqual(accepted)
    await env.EVENTS_DB.prepare("UPDATE deliveries SET status = 'exhausted', generation = 9 WHERE event_id = ?")
      .bind(EVENT).run()
    expect(await result('retry_apply', { planId: review.planId })).toEqual(accepted)
    expect(queue.messages).toHaveLength(1)
    expect(await result('delivery', delivery)).toMatchObject({ status: 'exhausted', generation: 9 })
  })

  it('makes concurrent confirmations of one or competing plans accept only one reviewed transition', async () => {
    const first = await plan()
    const second = await plan()
    const responses = await Promise.all([
      call('retry_apply', { planId: first.planId }),
      call('retry_apply', { planId: first.planId }),
      call('retry_apply', { planId: second.planId }),
    ])
    const receipts = await Promise.all(responses.map(response => response.json() as Promise<{ result?: CommandResults['retry_apply'] }>))
    const acceptedPlans = new Set(receipts.flatMap(value => value.result?.state === 'accepted' ? [value.result.planId] : []))
    expect(acceptedPlans.size).toBe(1)
    expect(queue.messages).toHaveLength(1)
  })

  it('rejects drift, expired plans, identity changes, and a reused plan with different inputs', async () => {
    const review = await plan()
    expect((await call('retry_apply', { planId: review.planId, actorId: 'another-owner' })).status).toBe(404)
    credential.revision = 2
    expect((await call('retry_apply', { planId: review.planId })).status).toBe(404)
    credential.revision = 1
    expect((await call('retry_plan', {
      ...delivery, planId: review.planId, generation: 5, updatedAt: TIMESTAMP,
    })).status).toBe(409)
    await env.EVENTS_DB.prepare("UPDATE deliveries SET generation = 5 WHERE event_id = ?").bind(EVENT).run()
    expect((await call('retry_apply', { planId: review.planId })).status).toBe(409)
    await env.EVENTS_DB.prepare('UPDATE management_retry_plans SET expires_at = ? WHERE id = ?')
      .bind(TIMESTAMP, review.planId).run()
    expect(await result('retry_get', { planId: review.planId })).toMatchObject({ state: 'expired' })
    expect((await call('retry_apply', { planId: review.planId })).status).toBe(409)
    expect(queue.messages).toHaveLength(0)
  })

  it('requires retained normalized data both at review and acceptance', async () => {
    const review = await plan()
    await env.EVENTS_RAW.delete('events/synthetic.json')
    const response = await call('retry_apply', { planId: review.planId })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('payload_unavailable')
    expect((await call('retry_plan', {
      ...delivery, planId: crypto.randomUUID(), generation: 4, updatedAt: TIMESTAMP,
    })).status).toBe(409)
    expect(queue.messages).toHaveLength(0)
  })

  it('keeps durable acceptance when queue publication fails and recovers through the existing outbox', async () => {
    const log = vi.spyOn(console, 'log')
    const review = await plan()
    const failed = recordingQueue(new Error(PRIVATE))
    const response = await call('retry_apply', { planId: review.planId }, TOKEN, withDeliveryQueue(runtime, failed.binding))
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain(PRIVATE)
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE)
    const error = await env.EVENTS_DB.prepare('SELECT last_error FROM deliveries WHERE event_id = ?')
      .bind(EVENT).first<{ last_error: string }>()
    expect(error?.last_error).toBe('Queue publication is deferred')
    expect(await result('retry_get', { planId: review.planId })).toMatchObject({ state: 'accepted' })
    expect(await result('delivery', delivery)).toMatchObject({ status: 'pending', generation: 6 })
    expect(await enqueuePendingDeliveries(runtime)).toMatchObject({ queued: 1 })
    expect(queue.messages).toEqual([{ version: 1, ...delivery, generation: 7 }])
    expect(await result('retry_apply', { planId: review.planId })).toMatchObject({ acceptedGeneration: 5 })
    expect(queue.messages).toHaveLength(1)
  })

  it('reconciles accepted operations even after the event was pruned', async () => {
    const review = await plan()
    const accepted = await result('retry_apply', { planId: review.planId })
    await env.EVENTS_DB.prepare('DELETE FROM events WHERE id = ?').bind(EVENT).run()
    expect(await result('retry_get', { planId: review.planId })).toEqual(accepted)
    expect(await result('retry_apply', { planId: review.planId })).toEqual(accepted)
    expect(queue.messages).toHaveLength(1)
  })

  it('bounds pending reviews and prunes old receipts in bounded maintenance batches', async () => {
    for (let index = 0; index < MANAGEMENT_LIMITS.PENDING_PLANS; index += 1) await plan()
    expect((await call('retry_plan', {
      ...delivery, planId: crypto.randomUUID(), generation: 4, updatedAt: TIMESTAMP,
    })).status).toBe(409)
    await env.EVENTS_DB.prepare('UPDATE management_retry_plans SET expires_at = ?').bind(TIMESTAMP).run()
    await pruneManagementReceipts(runtime)
    const count = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS n FROM management_retry_plans').first<{ n: number }>()
    expect(count?.n).toBe(0)
    await env.EVENTS_DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO management_retry_plans (id, client_id, client_revision, workspace_id, actor_id,
         event_id, sink_name, expected_generation, expected_updated_at, created_at, expires_at)
       SELECT 'old-' || i, 'hq', 1, 'workspace', 'owner', ?, 'phone', 4, ?, ?, ? FROM n`,
    ).bind(MANAGEMENT_LIMITS.PRUNE_BATCH + 1, EVENT, TIMESTAMP, TIMESTAMP, TIMESTAMP).run()
    await pruneManagementReceipts(runtime)
    const remaining = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS n FROM management_retry_plans').first<{ n: number }>()
    expect(remaining?.n).toBe(1)
  })

  it('recovers a lost acceptance response without creating a new retry identity', async () => {
    const review = await plan()
    const log = vi.spyOn(console, 'log')
    const unavailable = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property === 'EVENTS_DB') return new Proxy(env.EVENTS_DB, {
          get(database, name) {
            if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
              await database.batch(statements)
              throw new Error(PRIVATE)
            }
            const value = Reflect.get(database, name)
            return typeof value === 'function' ? value.bind(database) : value
          },
        })
        return Reflect.get(target, property, receiver)
      },
    })
    const response = await call('retry_apply', { planId: review.planId }, TOKEN, unavailable)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(PRIVATE)
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE)
    const accepted = await result('retry_get', { planId: review.planId })
    expect(accepted).toMatchObject({ state: 'accepted', acceptedGeneration: 5 })
    expect(await result('retry_apply', { planId: review.planId })).toEqual(accepted)
    expect(queue.messages).toHaveLength(0)
    expect(await enqueuePendingDeliveries(runtime)).toMatchObject({ queued: 1 })
  })

  it('leaves delivery state unchanged when durable acceptance fails', async () => {
    const review = await plan()
    const unavailable = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property === 'EVENTS_DB') return new Proxy(env.EVENTS_DB, {
          get(database, name) {
            if (name === 'batch') return async () => { throw new Error(PRIVATE) }
            const value = Reflect.get(database, name)
            return typeof value === 'function' ? value.bind(database) : value
          },
        })
        return Reflect.get(target, property, receiver)
      },
    })
    expect((await call('retry_apply', { planId: review.planId }, TOKEN, unavailable)).status).toBe(503)
    expect(await result('retry_get', { planId: review.planId })).toMatchObject({ state: 'review' })
    expect(await result('delivery', delivery)).toMatchObject({ status: 'exhausted', generation: 4 })
    expect(queue.messages).toHaveLength(0)
  })

  it('rolls back the acceptance receipt when a later statement in the real D1 batch fails', async () => {
    const review = await plan()
    await env.EVENTS_DB.exec("CREATE TRIGGER management_test_reject BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'synthetic batch rejection'); END;")
    try {
      expect((await call('retry_apply', { planId: review.planId })).status).toBe(503)
      expect(await result('retry_get', { planId: review.planId })).toMatchObject({ state: 'review' })
      expect(await result('delivery', delivery)).toMatchObject({ status: 'exhausted', generation: 4 })
      expect(queue.messages).toHaveLength(0)
    } finally { await env.EVENTS_DB.exec('DROP TRIGGER management_test_reject;') }
  })
})
