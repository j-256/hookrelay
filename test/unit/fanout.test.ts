import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fanout } from '../../src/fanout'
import { primaryKey } from '../../src/persistence'
import { registerSink } from '../../src/sinks'
import type { Sink } from '../../src/sinks'
import type { NormalizedEvent } from '../../src/types'
import { z } from 'zod'

const event: NormalizedEvent = {
  source: 'fixture',
  subName: 'fixture-sub',
  type: 'fixture.event',
  id: 'evt-1',
  timestamp: '2026-06-06T00:00:00.000Z',
  title: 't',
  body: 'b',
  raw: {},
}

const okSpy = vi.fn(async () => {})
const failSpy = vi.fn(async () => {
  throw new Error('boom')
})

const okSink: Sink<{ note: string }> = {
  type: 'fanout-ok',
  configSchema: z.object({ note: z.string() }).strict(),
  send: okSpy,
}
const failSink: Sink<{}> = {
  type: 'fanout-fail',
  configSchema: z.object({}).strict(),
  send: failSpy,
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  // Register fake sinks once. Wrap in try/catch in case a sibling test file already registered them
  try { registerSink(okSink) } catch {}
  try { registerSink(failSink) } catch {}
})

beforeEach(async () => {
  okSpy.mockClear()
  failSpy.mockClear()
  await env.EVENTS_DB.exec('DELETE FROM events')
  await env.EVENTS_DB.prepare(
    `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
    .bind(primaryKey(event), '2026-06-06T00:00:00.000Z', 'slug', 'fixture-sub', 'fixture', 'fixture.event', 't', 'r2-key')
    .run()

  await env.SINKS.put('sink:ok-a', JSON.stringify({ type: 'fanout-ok', note: 'hi' }))
  await env.SINKS.put('sink:fail-a', JSON.stringify({ type: 'fanout-fail' }))
})

afterEach(async () => {
  await env.SINKS.delete('sink:ok-a')
  await env.SINKS.delete('sink:fail-a')
})

describe('fanout', () => {
  it('invokes every sink and writes per-sink results to D1', async () => {
    await fanout(event, ['ok-a', 'fail-a'], env)
    expect(okSpy).toHaveBeenCalledOnce()
    expect(failSpy).toHaveBeenCalledOnce()

    const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind(primaryKey(event))
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results['ok-a']).toEqual({ ok: true })
    expect(results['fail-a'].ok).toBe(false)
    expect(results['fail-a'].errMsg).toContain('boom')
  })

  it('records a missing-sink error without throwing', async () => {
    await fanout(event, ['ok-a', 'no-such-sink'], env)
    const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind(primaryKey(event))
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results['ok-a']).toEqual({ ok: true })
    expect(results['no-such-sink'].ok).toBe(false)
    expect(results['no-such-sink'].errMsg).toMatch(/no-such-sink/)
  })

  it('records an unknown-sink-type error when KV references a type that is not registered', async () => {
    await env.SINKS.put('sink:bogus', JSON.stringify({ type: 'unregistered' }))
    await fanout(event, ['bogus'], env)
    const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind(primaryKey(event))
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results['bogus'].ok).toBe(false)
    expect(results['bogus'].errMsg).toMatch(/unregistered/)
    await env.SINKS.delete('sink:bogus')
  })

  it('returns successfully even when every sink fails', async () => {
    await env.EVENTS_DB.exec('DELETE FROM events')
    await env.EVENTS_DB.prepare(
      `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
      .bind(primaryKey(event), '2026-06-06T00:00:00.000Z', 'slug', 'fixture-sub', 'fixture', 'fixture.event', 't', 'r2-key')
      .run()

    await expect(fanout(event, ['fail-a'], env)).resolves.toBeUndefined()
  })
})
