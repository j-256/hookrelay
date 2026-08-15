import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Env } from '../../src/index'
import { OPERATIONS_FALLBACK_PREFIX } from '../../src/lib/runtime-config'
import {
  dispatchOperationalAlerts,
  importOperationalFallbacks,
  recordOperationalSignal,
  recordStaleDeliveries,
  resolveDeliverySignals,
} from '../../src/operations'
import { registerSink, type Sink } from '../../src/sinks'

const SUB_HASH = 'a'.repeat(64)
const EVENT_ID = 'fixture:operations-event'
const FAILING_SINK = 'operations-observer'
const IMPLICATED_SINK = 'operations-implicated'
const failureSpy = vi.fn(async () => {
  throw new Error('DATABASE_SECRET must never be stored')
})

const failingSink: Sink<{}> = {
  type: 'operations-test-failure',
  configSchema: z.object({}).strict(),
  send: failureSpy,
}

async function clearFallbacks(): Promise<void> {
  const listed = await env.SUBS.list({ prefix: OPERATIONS_FALLBACK_PREFIX })
  await Promise.all(listed.keys.map((key) => env.SUBS.delete(key.name)))
}

function withUnavailableDatabase(): Env {
  return new Proxy(env as unknown as Env, {
    get(target, property, receiver) {
      if (property === 'EVENTS_DB') {
        return {
          prepare() {
            throw new Error('DATABASE_SECRET must never be stored')
          },
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  try { registerSink(failingSink) } catch {}
})

beforeEach(async () => {
  failureSpy.mockClear()
  await env.EVENTS_DB.exec(
    'DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM deliveries; DELETE FROM events;',
  )
  await clearFallbacks()
  await env.SINKS.put(`sink:${FAILING_SINK}`, JSON.stringify({ type: failingSink.type }))
  await env.SINKS.put(`sink:${IMPLICATED_SINK}`, JSON.stringify({ type: failingSink.type }))
})

describe('operational signals', () => {
  it('aggregates a fixed summary without accepting exception text', async () => {
    const input = {
      code: 'ingress-authentication-rejected' as const,
      source: 'github',
      subName: 'repo',
    }
    await recordOperationalSignal(env as unknown as Env, input)
    await recordOperationalSignal(env as unknown as Env, input)

    const row = await env.EVENTS_DB.prepare(
      `SELECT code, severity, summary, occurrences, source, sub_name
       FROM operational_signals`,
    ).first<{
      code: string
      severity: string
      summary: string
      occurrences: number
      source: string
      sub_name: string
    }>()
    expect(row).toEqual({
      code: 'ingress-authentication-rejected',
      severity: 'warning',
      summary: 'A known route rejected webhook authentication',
      occurrences: 2,
      source: 'github',
      sub_name: 'repo',
    })
  })

  it('falls back to fixed-field KV and imports it after D1 recovers', async () => {
    await recordOperationalSignal(withUnavailableDatabase(), {
      code: 'ingress-persistence-rejected',
      source: 'github',
      subName: 'repo',
      eventId: 'github:event-1',
    })

    const listed = await env.SUBS.list({ prefix: OPERATIONS_FALLBACK_PREFIX })
    expect(listed.keys).toHaveLength(1)
    const stored = await env.SUBS.get(listed.keys[0]!.name)
    expect(stored).not.toContain('DATABASE_SECRET')
    expect(Object.keys(JSON.parse(stored!)).sort()).toEqual([
      'code',
      'eventId',
      'observedAt',
      'source',
      'subName',
      'version',
    ])

    await expect(importOperationalFallbacks(env as unknown as Env)).resolves.toBe(1)
    expect((await env.SUBS.list({ prefix: OPERATIONS_FALLBACK_PREFIX })).keys).toHaveLength(0)
    await expect(
      env.EVENTS_DB.prepare('SELECT code, occurrences FROM operational_signals').first(),
    ).resolves.toEqual({ code: 'ingress-persistence-rejected', occurrences: 1 })
  })

  it('records stale active deliveries and resolves them on recovery', async () => {
    await env.EVENTS_DB.prepare(
      `INSERT INTO events
       (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
      .bind(
        EVENT_ID,
        '2020-01-01T00:00:00.000Z',
        SUB_HASH,
        'fixture-sub',
        'fixture',
        'fixture.event',
        'Fixture event',
        'events/fixture.raw',
      )
      .run()
    await env.EVENTS_DB.prepare(
      `INSERT INTO deliveries
       (event_id, sink_name, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'retrying', 1, ?, ?)`,
    )
      .bind(EVENT_ID, FAILING_SINK, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
      .run()

    await expect(recordStaleDeliveries(env as unknown as Env, {
      sinks: [FAILING_SINK],
      alertCooldownMinutes: 60,
      staleDeliveryMinutes: 15,
    })).resolves.toBe(1)
    await expect(
      env.EVENTS_DB.prepare('SELECT code, resolved_at FROM operational_signals').first(),
    ).resolves.toEqual({ code: 'delivery-stale', resolved_at: null })

    await resolveDeliverySignals(env as unknown as Env, EVENT_ID, FAILING_SINK)
    const resolved = await env.EVENTS_DB.prepare(
      'SELECT resolved_at FROM operational_signals',
    ).first<{ resolved_at: string | null }>()
    expect(resolved?.resolved_at).not.toBeNull()
  })

  it('skips implicated sinks and does not recurse when an alert fails', async () => {
    await recordOperationalSignal(env as unknown as Env, {
      code: 'delivery-exhausted',
      source: 'fixture',
      subName: 'fixture-sub',
      eventId: EVENT_ID,
      sinkName: IMPLICATED_SINK,
    })

    await expect(dispatchOperationalAlerts(env as unknown as Env, {
      sinks: [IMPLICATED_SINK, FAILING_SINK],
      alertCooldownMinutes: 60,
      staleDeliveryMinutes: 15,
    })).resolves.toEqual({ delivered: 0, failed: 1, skipped: 1 })
    expect(failureSpy).toHaveBeenCalledOnce()
    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM operational_signals').first(),
    ).resolves.toEqual({ total: 1 })
    const alert = await env.EVENTS_DB.prepare(
      `SELECT sink_name, attempts, last_error
       FROM operational_alert_deliveries`,
    ).first<{ sink_name: string; attempts: number; last_error: string }>()
    expect(alert).toEqual({
      sink_name: FAILING_SINK,
      attempts: 1,
      last_error: 'operations alert delivery failed',
    })
    expect(JSON.stringify(alert)).not.toContain('DATABASE_SECRET')
  })
})
