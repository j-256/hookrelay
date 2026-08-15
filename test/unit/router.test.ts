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
  await env.EVENTS_DB.exec('DELETE FROM events')
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

  it('persists record-only events without creating sink deliveries', async () => {
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
    const deliveries = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS count FROM deliveries WHERE event_id = ?')
      .bind('fixture:record-only')
      .first<{ count: number }>()
    expect(event?.id).toBe('fixture:record-only')
    expect(deliveries?.count).toBe(0)
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
