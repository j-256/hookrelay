import { env } from 'cloudflare:test'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { persistEvent, primaryKey, r2Keys, updateFanoutResult } from '../../src/persistence'
import type { NormalizedEvent } from '../../src/types'

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM events')
})

const makeEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  source: 'statuspage',
  subName: 'claude-status',
  type: 'incident.created',
  id: 'inc-123:upd-456',
  timestamp: '2026-06-06T12:00:00.000Z',
  title: 'Investigating',
  body: 'We are investigating...',
  severity: 'info',
  raw: { foo: 'bar' },
  ...overrides,
})

describe('primaryKey', () => {
  it('namespaces event id by source', () => {
    expect(primaryKey({ source: 'github', id: 'abc' } as NormalizedEvent)).toBe('github:abc')
  })
})

describe('r2Keys', () => {
  it('produces .raw and .json keys partitioned by date', () => {
    const event = makeEvent({ source: 'github', id: 'abc/def' })
    const keys = r2Keys(event, '2026-06-06T00:00:00.000Z')
    expect(keys.raw).toBe('events/2026/06/06/github_abc_def.raw')
    expect(keys.json).toBe('events/2026/06/06/github_abc_def.json')
  })

  it('replaces : in event id with _', () => {
    const event = makeEvent({ source: 'statuspage', id: 'a:b' })
    const keys = r2Keys(event, '2026-06-06T00:00:00.000Z')
    expect(keys.raw).toContain('statuspage_a_b.raw')
  })
})

describe('persistEvent', () => {
  it('inserts an event and writes both R2 objects', async () => {
    const event = makeEvent()
    const raw = new TextEncoder().encode('{"raw":"body"}')
    const result = await persistEvent(env, event, raw, 'application/json', 'slug123')

    expect(result.duplicate).toBe(false)

    const row = await env.EVENTS_DB.prepare(
      'SELECT id, source, sub_slug, fanout_results FROM events WHERE id = ?',
    ).bind('statuspage:inc-123:upd-456').first<{ id: string; source: string; sub_slug: string; fanout_results: string }>()
    expect(row?.source).toBe('statuspage')
    expect(row?.sub_slug).toBe('slug123')
    expect(JSON.parse(row?.fanout_results ?? '{}')).toEqual({})

    const rawObj = await env.EVENTS_RAW.get(result.r2Keys.raw)
    expect(await rawObj?.text()).toBe('{"raw":"body"}')
    expect(rawObj?.httpMetadata?.contentType).toBe('application/json')

    const jsonObj = await env.EVENTS_RAW.get(result.r2Keys.json)
    expect(JSON.parse(await jsonObj!.text()).id).toBe('inc-123:upd-456')
  })

  it('reports duplicate on second persist and preserves existing R2 objects', async () => {
    const event = makeEvent()
    const raw = new TextEncoder().encode('first')
    const first = await persistEvent(env, event, raw, 'application/json', 'slug123')
    expect(first.duplicate).toBe(false)

    const raw2 = new TextEncoder().encode('second')
    const second = await persistEvent(env, event, raw2, 'application/json', 'slug123')
    expect(second.duplicate).toBe(true)

    // The first write remains authoritative while a retry can repair missing objects
    const rawObj = await env.EVENTS_RAW.get(first.r2Keys.raw)
    expect(await rawObj?.text()).toBe('first')
  })

  it('repairs a missing normalized object when the sender retries', async () => {
    const event = makeEvent()
    const first = await persistEvent(
      env,
      event,
      new TextEncoder().encode('first'),
      'application/json',
      'slug123',
    )
    await env.EVENTS_RAW.delete(first.r2Keys.json)

    const duplicate = await persistEvent(
      env,
      { ...event, title: 'Retry copy' },
      new TextEncoder().encode('second'),
      'application/json',
      'slug123',
    )

    expect(duplicate.duplicate).toBe(true)
    expect(await (await env.EVENTS_RAW.get(first.r2Keys.raw))?.text()).toBe('first')
    const repaired = await env.EVENTS_RAW.get(first.r2Keys.json)
    expect(JSON.parse(await repaired!.text()).title).toBe('Retry copy')
  })
})

describe('updateFanoutResult', () => {
  it('merges independent sink results without replacing another sink', async () => {
    const event = makeEvent()
    const raw = new TextEncoder().encode('{}')
    await persistEvent(env, event, raw, 'application/json', 'slug123')

    await Promise.all([
      updateFanoutResult(env, primaryKey(event), 'phone', { ok: true }),
      updateFanoutResult(env, primaryKey(event), 'discord-personal', {
        ok: false,
        errMsg: '404',
      }),
    ])

    const row = await env.EVENTS_DB.prepare(
      'SELECT fanout_results FROM events WHERE id = ?',
    ).bind('statuspage:inc-123:upd-456').first<{ fanout_results: string }>()
    expect(JSON.parse(row?.fanout_results ?? '{}')).toEqual({
      phone: { ok: true },
      'discord-personal': { ok: false, errMsg: '404' },
    })
  })
})
