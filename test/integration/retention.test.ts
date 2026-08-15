import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/index'
import { RETENTION_CONFIG_KEY } from '../../src/lib/runtime-config'
import {
  D1_RETENTION_BATCH_SIZE,
  RETENTION_LAST_SUCCESS_KEY,
  runD1Retention,
} from '../../src/retention'

const SUB_HASH = 'a'.repeat(64)
const NOW = new Date('2026-08-15T12:00:00.000Z')

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec(
    'DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM maintenance_state; DELETE FROM deliveries; DELETE FROM events;',
  )
  await env.SUBS.delete(RETENTION_CONFIG_KEY)
  const fallbacks = await env.SUBS.list({ prefix: 'ops-fallback:' })
  await Promise.all(fallbacks.keys.map((key) => env.SUBS.delete(key.name)))
})

async function seedEvent(id: string, receivedAt: string): Promise<void> {
  await env.EVENTS_DB.prepare(
    `INSERT INTO events
     (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
     VALUES (?, ?, ?, 'fixture', 'fixture', 'fixture.event', ?, ?, '{}')`,
  )
    .bind(id, receivedAt, SUB_HASH, id, `events/${id}.raw`)
    .run()
  await env.EVENTS_DB.prepare(
    `INSERT INTO deliveries
     (event_id, sink_name, status, attempts, created_at, updated_at)
     VALUES (?, 'sink', 'delivered', 1, ?, ?)`,
  )
    .bind(id, receivedAt, receivedAt)
    .run()
}

describe('D1 retention maintenance', () => {
  it('is disabled by omission and does not delete events', async () => {
    await seedEvent('fixture:old', '2020-01-01T00:00:00.000Z')
    await expect(runD1Retention(env as unknown as Env, NOW)).resolves.toEqual({
      status: 'disabled',
      deleted: 0,
    })
    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM events').first(),
    ).resolves.toEqual({ total: 1 })
  })

  it('deletes one bounded batch daily and cascades delivery rows', async () => {
    await env.SUBS.put(RETENTION_CONFIG_KEY, JSON.stringify({ d1Days: 30 }))
    for (let index = 0; index < D1_RETENTION_BATCH_SIZE + 1; index += 1) {
      await seedEvent(`fixture:old-${index}`, '2020-01-01T00:00:00.000Z')
    }
    await seedEvent('fixture:recent', '2026-08-14T00:00:00.000Z')

    await expect(runD1Retention(env as unknown as Env, NOW)).resolves.toEqual({
      status: 'succeeded',
      deleted: D1_RETENTION_BATCH_SIZE,
    })
    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM events').first(),
    ).resolves.toEqual({ total: 2 })
    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM deliveries').first(),
    ).resolves.toEqual({ total: 2 })
    const success = await env.EVENTS_DB.prepare(
      'SELECT value, updated_at FROM maintenance_state WHERE key = ?',
    )
      .bind(RETENTION_LAST_SUCCESS_KEY)
      .first<{ value: string; updated_at: string }>()
    expect(success?.updated_at).toBe(NOW.toISOString())
    expect(JSON.parse(success!.value)).toMatchObject({ deleted: D1_RETENTION_BATCH_SIZE })

    const oneHourLater = new Date(NOW.getTime() + 60 * 60 * 1000)
    await expect(runD1Retention(env as unknown as Env, oneHourLater)).resolves.toEqual({
      status: 'skipped',
      deleted: 0,
    })
    const nextDay = new Date(NOW.getTime() + 25 * 60 * 60 * 1000)
    await expect(runD1Retention(env as unknown as Env, nextDay)).resolves.toEqual({
      status: 'succeeded',
      deleted: 1,
    })
    await expect(
      env.EVENTS_DB.prepare('SELECT id FROM events').all(),
    ).resolves.toMatchObject({ results: [{ id: 'fixture:recent' }] })
  })

  it('falls back to a redacted operational signal when D1 is unavailable', async () => {
    await env.SUBS.put(RETENTION_CONFIG_KEY, JSON.stringify({ d1Days: 30 }))
    const unavailable = new Proxy(env as unknown as Env, {
      get(target, property, receiver) {
        if (property === 'EVENTS_DB') {
          return {
            prepare() {
              throw new Error('DATABASE_SECRET must not escape')
            },
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })

    await expect(runD1Retention(unavailable, NOW)).resolves.toEqual({
      status: 'failed',
      deleted: 0,
    })
    const listed = await env.SUBS.list({ prefix: 'ops-fallback:' })
    expect(listed.keys).toHaveLength(1)
    const stored = await env.SUBS.get(listed.keys[0]!.name)
    expect(stored).toContain('retention-prune-rejected')
    expect(stored).not.toContain('DATABASE_SECRET')
    await env.SUBS.delete(listed.keys[0]!.name)
  })

  it('runs the configured pruning pass from the scheduled handler', async () => {
    await env.SUBS.put(RETENTION_CONFIG_KEY, JSON.stringify({ d1Days: 30 }))
    await seedEvent('fixture:scheduled-old', '2020-01-01T00:00:00.000Z')

    await worker.scheduled(
      {} as ScheduledController,
      env as unknown as Env,
    )

    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM events').first(),
    ).resolves.toEqual({ total: 0 })
    await expect(
      env.EVENTS_DB.prepare(
        'SELECT updated_at FROM maintenance_state WHERE key = ?',
      ).bind(RETENTION_LAST_SUCCESS_KEY).first(),
    ).resolves.not.toBeNull()
  })
})
