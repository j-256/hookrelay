import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import '../../src/registry'
import { handleHook, parseHookPath, SLUG_PATH_RE } from '../../src/router'
import { registerAdapter } from '../../src/adapters'
import type { Adapter } from '../../src/adapters'
import { hashSubscriptionSlug, subscriptionKvKey, subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import type { Subscription } from '../../src/types'

const SUB_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2'
const SUB_HASH = await hashSubscriptionSlug(SUB_SLUG)
const SUB_KEY = subscriptionKvKey(SUB_HASH)
const sub: Subscription = {
  name: 'fixture-sub',
  source: 'fixture',
  enabled: true,
  sinks: [],
  auth: null,
}

const fixture: Adapter = {
  sourceType: 'fixture',
  async verify(_req, _raw, _sub, _env) {
    /* no-op */
  },
  async parse(_req, raw, s) {
    const text = new TextDecoder().decode(raw)
    return {
      source: 'fixture',
      subName: s.name,
      type: 'fixture.event',
      id: text.trim() || 'unknown',
      timestamp: '2026-06-06T00:00:00.000Z',
      title: 'fixture',
      body: text,
      ...(text === 'source-url' ? { url: 'https://status.example.test/incidents/source' } : {}),
      shouldDeliver: text !== 'record-only',
      raw: text,
    }
  },
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  try { registerAdapter(fixture) } catch {}
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM events')
  await env.SUBS.put(SUB_KEY, JSON.stringify(sub))
})

afterEach(async () => {
  await env.SUBS.delete(SUB_KEY)
})

describe('SLUG_PATH_RE', () => {
  it('matches valid slug-shape paths', () => {
    expect(SLUG_PATH_RE.test(`/hook/fixture/${SUB_SLUG}`)).toBe(true)
    expect(SLUG_PATH_RE.test('/hook/cf-notif/' + 'a'.repeat(22))).toBe(true)
  })

  it('rejects too-short slugs', () => {
    expect(SLUG_PATH_RE.test('/hook/fixture/' + 'a'.repeat(21))).toBe(false)
  })

  it('rejects extra path segments', () => {
    expect(SLUG_PATH_RE.test(`/hook/fixture/${SUB_SLUG}/extra`)).toBe(false)
  })

  it('rejects bad sourceType characters', () => {
    expect(SLUG_PATH_RE.test(`/hook/Fixture/${SUB_SLUG}`)).toBe(false)
  })
})

describe('parseHookPath', () => {
  it('extracts sourceType and slug', () => {
    expect(parseHookPath(`/hook/fixture/${SUB_SLUG}`)).toEqual({ sourceType: 'fixture', slug: SUB_SLUG })
  })

  it('returns null for non-hook paths', () => {
    expect(parseHookPath('/admin/events')).toBeNull()
  })
})

describe('handleHook', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

  it('returns 404 for unknown slug', async () => {
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${'z'.repeat(22)}`, { method: 'POST', body: 'x' }),
      env,
      ctx,
    )
    expect(res.status).toBe(404)
    await expect(
      env.EVENTS_DB.prepare('SELECT COUNT(*) AS total FROM operational_signals').first(),
    ).resolves.toEqual({ total: 0 })
  })

  it('returns 404 for slug-source mismatch', async () => {
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/github/${SUB_SLUG}`, { method: 'POST', body: 'x' }),
      env,
      ctx,
    )
    expect(res.status).toBe(404)
  })

  it('returns 204 for disabled sub', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({ ...sub, enabled: false }))
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, { method: 'POST', body: 'x' }),
      env,
      ctx,
    )
    expect(res.status).toBe(204)
  })

  it('returns 413 for body over 1 MB', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1)
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: big,
        headers: { 'content-length': String(big.length) },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(413)
    const signal = await env.EVENTS_DB.prepare(
      'SELECT code, summary, source, sub_name FROM operational_signals',
    ).first()
    expect(signal).toEqual({
      code: 'ingress-payload-too-large',
      summary: 'A known route rejected an oversized payload',
      source: 'fixture',
      sub_name: 'fixture-sub',
    })
    expect(JSON.stringify(signal)).not.toContain(big.slice(0, 100))
  })

  it('persists event and returns 200 on happy path', async () => {
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'event-1',
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ ok: boolean; eventId: string; duplicate?: boolean }>()
    expect(body.ok).toBe(true)
    expect(body.eventId).toBe('fixture:event-1')

    const row = await env.EVENTS_DB.prepare('SELECT id, sub_slug FROM events WHERE id = ?')
      .bind('fixture:event-1')
      .first<{ id: string; sub_slug: string }>()
    expect(row?.sub_slug).toBe(SUB_HASH)
  })

  it('persists a fallback URL when the adapter has no specific target', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({
      ...sub,
      fallbackUrl: 'https://status.example.test/',
    }))
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'fallback-event',
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const row = await env.EVENTS_DB.prepare('SELECT url FROM events WHERE id = ?')
      .bind('fixture:fallback-event')
      .first<{ url: string | null }>()
    expect(row?.url).toBe('https://status.example.test/')
  })

  it('prefers an adapter URL over the subscription fallback', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({
      ...sub,
      fallbackUrl: 'https://status.example.test/',
    }))
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'source-url',
      }),
      env,
      ctx,
    )

    expect(res.status).toBe(200)
    const row = await env.EVENTS_DB.prepare('SELECT url FROM events WHERE id = ?')
      .bind('fixture:source-url')
      .first<{ url: string | null }>()
    expect(row?.url).toBe('https://status.example.test/incidents/source')
  })

  it('returns duplicate:true on second POST of same id', async () => {
    const make = () =>
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'event-1',
      })
    const first = await handleHook(make(), env, ctx)
    expect(first.status).toBe(200)
    const second = await handleHook(make(), env, ctx)
    expect(second.status).toBe(200)
    const body = await second.json<{ duplicate?: boolean }>()
    expect(body.duplicate).toBe(true)
  })

  it('persists an explicit filtered decision for record-only events', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({ ...sub, sinks: ['phone'] }))
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'record-only',
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    const event = await env.EVENTS_DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind('fixture:record-only')
      .first<{ id: string }>()
    const delivery = await env.EVENTS_DB.prepare(
      'SELECT status, decision_reason FROM deliveries WHERE event_id = ? AND sink_name = ?',
    )
      .bind('fixture:record-only', 'phone')
      .first<{ status: string; decision_reason: string | null }>()
    expect(event?.id).toBe('fixture:record-only')
    expect(delivery).toEqual({ status: 'filtered', decision_reason: 'source-record-only' })
  })

  it('persists filtered events while creating deliveries only for matches', async () => {
    await env.SUBS.put(SUB_KEY, JSON.stringify({
      ...sub,
      sinks: ['phone'],
      filter: { eventTypes: { include: ['fixture.event'], exclude: ['fixture.blocked'] } },
    }))
    const matching = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'filtered-match',
      }),
      env,
      ctx,
    )
    expect(matching.status).toBe(200)

    await env.SUBS.put(SUB_KEY, JSON.stringify({
      ...sub,
      sinks: ['phone'],
      filter: { eventTypes: { include: ['other.*'] } },
    }))
    const nonmatching = await handleHook(
      new Request(`https://hooks.example.com/hook/fixture/${SUB_SLUG}`, {
        method: 'POST',
        body: 'filtered-nonmatch',
      }),
      env,
      ctx,
    )
    expect(nonmatching.status).toBe(200)

    const events = await env.EVENTS_DB.prepare(
      `SELECT id FROM events WHERE id IN (?, ?) ORDER BY id`,
    )
      .bind('fixture:filtered-match', 'fixture:filtered-nonmatch')
      .all<{ id: string }>()
    const deliveries = await env.EVENTS_DB.prepare(
      `SELECT event_id, sink_name, status, decision_reason
       FROM deliveries WHERE event_id IN (?, ?) ORDER BY event_id`,
    )
      .bind('fixture:filtered-match', 'fixture:filtered-nonmatch')
      .all<{ event_id: string; sink_name: string }>()
    expect(events.results?.map((event) => event.id)).toEqual([
      'fixture:filtered-match',
      'fixture:filtered-nonmatch',
    ])
    expect(deliveries.results).toEqual([
      {
        event_id: 'fixture:filtered-match',
        sink_name: 'phone',
        status: 'queued',
        decision_reason: null,
      },
      {
        event_id: 'fixture:filtered-nonmatch',
        sink_name: 'phone',
        status: 'filtered',
        decision_reason: 'subscription-filter',
      },
    ])
  })

  it('returns 401 when adapter.verify throws', async () => {
    const guarded: Adapter = {
      sourceType: 'guarded',
      async verify() {
        throw new Error('bad signature')
      },
      async parse() {
        throw new Error('should not reach parse')
      },
    }
    try { registerAdapter(guarded) } catch {}
    const SLUG2 = 'b8g4c3d9e0f5h6i7j8k9l0'
    const subKey2 = await subscriptionKvKeyForSlug(SLUG2)
    await env.SUBS.put(
      subKey2,
      JSON.stringify({ ...sub, source: 'guarded' }),
    )
    const res = await handleHook(
      new Request(`https://hooks.example.com/hook/guarded/${SLUG2}`, { method: 'POST', body: 'x' }),
      env,
      ctx,
    )
    expect(res.status).toBe(401)
    await env.SUBS.delete(subKey2)
  })
})
