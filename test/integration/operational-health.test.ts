import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import worker from '../../src/index'
import type { Env } from '../../src/index'
import { OPERATIONS_CONFIG_KEY } from '../../src/lib/runtime-config'
import { registerSink, type Sink } from '../../src/sinks'
import type { NormalizedEvent } from '../../src/types'

const EVENT_ID = 'fixture:stale-event'
const SUB_HASH = 'a'.repeat(64)
const OPERATIONS_SINK = 'operations-integration'
const sendSpy = vi.fn(async (_event: NormalizedEvent) => {})

const operationsSink: Sink<{}> = {
  type: 'operations-integration',
  configSchema: z.object({}).strict(),
  send: sendSpy,
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  try { registerSink(operationsSink) } catch {}
})

beforeEach(async () => {
  sendSpy.mockClear()
  await env.EVENTS_DB.exec(
    'DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM deliveries; DELETE FROM events;',
  )
  await env.SUBS.put(OPERATIONS_CONFIG_KEY, JSON.stringify({
    sinks: [OPERATIONS_SINK],
    alertCooldownMinutes: 60,
    staleDeliveryMinutes: 15,
  }))
  await env.SINKS.put(`sink:${OPERATIONS_SINK}`, JSON.stringify({ type: operationsSink.type }))
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
     VALUES (?, 'broken-sink', 'retrying', 2, ?, ?)`,
  )
    .bind(EVENT_ID, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')
    .run()
})

describe('scheduled operational maintenance', () => {
  it('detects a stale delivery and directly alerts the configured sink', async () => {
    await worker.scheduled(
      {} as ScheduledController,
      env as unknown as Env,
    )

    expect(sendSpy).toHaveBeenCalledOnce()
    const sent = sendSpy.mock.calls[0]![0]
    expect(sent).toMatchObject({
      source: 'hookrelay',
      subName: 'operations',
      type: 'hookrelay.operations.delivery-stale',
      title: 'A sink delivery remained active beyond its threshold',
      severity: 'warning',
    })
    expect(sent.body).toContain('Sink: broken-sink')
    await expect(
      env.EVENTS_DB.prepare(
        `SELECT operational_signals.code, operational_signals.occurrences,
                operational_alert_deliveries.sink_name,
                operational_alert_deliveries.alerted_occurrences,
                operational_alert_deliveries.last_error
         FROM operational_signals
         JOIN operational_alert_deliveries USING (fingerprint)`,
      ).first(),
    ).resolves.toEqual({
      code: 'delivery-stale',
      occurrences: 1,
      sink_name: OPERATIONS_SINK,
      alerted_occurrences: 1,
      last_error: null,
    })
  })
})
