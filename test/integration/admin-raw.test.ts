import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'

const SUB_HASH = 'a'.repeat(64)

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  ;(env as unknown as Record<string, string>).TEST_BYPASS_ACCESS = '1'
  await env.EVENTS_DB.exec('DELETE FROM events')
})

afterEach(() => {
  delete (env as unknown as Record<string, unknown>).TEST_BYPASS_ACCESS
})

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

async function insertRow(id: string, receivedAt: string, r2Key: string) {
  await env.EVENTS_DB.prepare(
    `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
    .bind(id, receivedAt, SUB_HASH, 'fixture', 'fixture', 'fixture.event', 't', r2Key)
    .run()
}

describe('GET /admin/events/{id}/raw', () => {
  it('returns the raw body when present in R2', async () => {
    const key = 'events/2026/06/06/fixture_id1.raw'
    await env.EVENTS_RAW.put(key, '{"hi":"there"}', { httpMetadata: { contentType: 'application/json' } })
    await insertRow('fixture:id1', new Date().toISOString(), key)

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/admin/events/${encodeURIComponent('fixture:id1')}/raw`),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.text()).toBe('{"hi":"there"}')
  })

  it('returns 404 when the event is unknown', async () => {
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events/missing/raw'),
      env,
      ctx,
    )
    expect(res.status).toBe(404)
  })

  it('returns 502 when R2 object is missing within retention window', async () => {
    const recent = new Date(Date.now() - 5 * 86400e3).toISOString()
    await insertRow('fixture:no-r2', recent, 'events/2026/06/01/fixture_no-r2.raw')

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/admin/events/${encodeURIComponent('fixture:no-r2')}/raw`),
      env,
      ctx,
    )
    expect(res.status).toBe(502)
    const body = await res.json<{ reason: string }>()
    expect(body.reason).toBe('missing')
  })

  it('returns 410 with received_at when R2 object is missing past retention', async () => {
    const ancient = new Date(Date.now() - 200 * 86400e3).toISOString()
    await insertRow('fixture:expired', ancient, 'events/2025/12/01/fixture_expired.raw')

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/admin/events/${encodeURIComponent('fixture:expired')}/raw`),
      env,
      ctx,
    )
    expect(res.status).toBe(410)
    const body = await res.json<{ reason: string; received_at: string }>()
    expect(body.reason).toBe('expired')
    expect(body.received_at).toBe(ancient)
  })

  it('returns 403 when CF Access bypass is off and JWT is missing', async () => {
    delete (env as unknown as Record<string, unknown>).TEST_BYPASS_ACCESS
    await insertRow('fixture:auth', new Date().toISOString(), 'events/2026/06/06/fixture_auth.raw')

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/admin/events/${encodeURIComponent('fixture:auth')}/raw`),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
  })
})
