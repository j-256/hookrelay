import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/index'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const SUB_HASH = 'a'.repeat(64)

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  delete (env as unknown as Record<string, unknown>).TEST_BYPASS_ACCESS
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')

  const events = [
    { id: 'github:d1', source: 'github', sub_name: 'gh', type: 'issues.opened', received_at: '2026-06-06T10:00:00Z', title: 'A' },
    { id: 'github:d2', source: 'github', sub_name: 'gh', type: 'pull_request.opened', received_at: '2026-06-06T11:00:00Z', title: 'B' },
    { id: 'statuspage:s1', source: 'statuspage', sub_name: 'cstat', type: 'incident.created', received_at: '2026-06-06T12:00:00Z', title: 'C' },
  ]
  for (const e of events) {
    await env.EVENTS_DB.prepare(
      `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
      .bind(e.id, e.received_at, SUB_HASH, e.sub_name, e.source, e.type, e.title, `events/2026/06/06/${e.id.replace(':', '_')}.raw`)
      .run()
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function bypassAccess() {
  ;(env as unknown as Record<string, unknown>).TEST_BYPASS_ACCESS = '1'
}

async function insertDelivery(
  eventId: string,
  status: 'queued' | 'delivered' | 'exhausted',
  sinkName = 'phone',
  lastError: string | null = null,
) {
  const timestamp = '2026-06-06T12:05:00Z'
  await env.EVENTS_DB.prepare(
    `INSERT INTO deliveries
     (event_id, sink_name, generation, status, attempts, last_error, created_at, updated_at)
     VALUES (?, ?, 1, ?, 1, ?, ?, ?)`,
  )
    .bind(eventId, sinkName, status, lastError, timestamp, timestamp)
    .run()
}

describe('GET /admin/events', () => {
  it('returns 403 when CF Access JWT is missing and bypass is off', async () => {
    delete (env as unknown as Record<string, unknown>).TEST_BYPASS_ACCESS
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events'),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('lists events newest-first', async () => {
    bypassAccess()
    const res = await worker.fetch(new Request('https://hooks.example.com/admin/events'), env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    const aIdx = html.indexOf('github:d1')
    const bIdx = html.indexOf('github:d2')
    const cIdx = html.indexOf('statuspage:s1')
    expect(cIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(-1)
    expect(aIdx).toBeGreaterThan(-1)
    // Newest first: statuspage:s1 (12:00) before github:d2 (11:00) before github:d1 (10:00)
    expect(cIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(aIdx)
  })

  it('renders a dark-first operational view without caching it', async () => {
    bypassAccess()
    const res = await worker.fetch(new Request('https://hooks.example.com/admin/events'), env, ctx)
    const html = await res.text()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    expect(html).toContain('<meta name="color-scheme" content="dark">')
    expect(html).toContain('color-scheme: dark')
    expect(html).toContain('Event activity')
    expect(html).toContain('Needs attention')
    expect(html).toContain('name="q"')
  })

  it('searches across event metadata', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?q=pull_request'),
      env,
      ctx,
    )
    const html = await res.text()
    expect(html).toContain('github:d2')
    expect(html).not.toContain('github:d1')
    expect(html).not.toContain('statuspage:s1')
  })

  it('filters events by operational delivery state', async () => {
    bypassAccess()
    await insertDelivery('github:d1', 'exhausted', 'phone', 'upstream unavailable')
    await insertDelivery('github:d2', 'queued')
    await insertDelivery('statuspage:s1', 'delivered')

    const attention = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?delivery=attention'),
      env,
      ctx,
    )
    const attentionHtml = await attention.text()
    expect(attentionHtml).toContain('github:d1')
    expect(attentionHtml).not.toContain('github:d2')
    expect(attentionHtml).not.toContain('statuspage:s1')
    expect(attentionHtml).toContain('upstream unavailable')

    const active = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?delivery=active'),
      env,
      ctx,
    )
    const activeHtml = await active.text()
    expect(activeHtml).toContain('github:d2')
    expect(activeHtml).not.toContain('github:d1')

    const delivered = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?delivery=delivered'),
      env,
      ctx,
    )
    const deliveredHtml = await delivered.text()
    expect(deliveredHtml).toContain('statuspage:s1')
    expect(deliveredHtml).not.toContain('github:d2')
  })

  it('shows exact result counts and navigation in both directions', async () => {
    bypassAccess()
    const statements = Array.from({ length: 51 }, (_, index) => {
      const receivedAt = new Date(Date.UTC(2026, 5, 7, 0, 0, index)).toISOString()
      return env.EVENTS_DB.prepare(
        `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      ).bind(
        `bulk:${index}`,
        receivedAt,
        SUB_HASH,
        'bulk',
        'bulk',
        'bulk.event',
        `Bulk event ${index}`,
        `events/bulk_${index}.raw`,
      )
    })
    await env.EVENTS_DB.batch(statements)

    const first = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?source=bulk'),
      env,
      ctx,
    )
    const firstHtml = await first.text()
    expect(firstHtml).toContain('Showing <strong>1-50</strong> of <strong>51</strong>')
    expect(firstHtml).toContain('rel="next"')
    expect(firstHtml).not.toContain('rel="prev"')

    const second = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?source=bulk&page=2'),
      env,
      ctx,
    )
    const secondHtml = await second.text()
    expect(secondHtml).toContain('bulk:0')
    expect(secondHtml).toContain('rel="prev"')
    expect(secondHtml).not.toContain('rel="next"')
  })

  it('filters by source', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?source=github'),
      env,
      ctx,
    )
    const html = await res.text()
    expect(html).toContain('github:d1')
    expect(html).not.toContain('statuspage:s1')
  })

  it('filters by sub', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?sub=cstat'),
      env,
      ctx,
    )
    const html = await res.text()
    expect(html).toContain('statuspage:s1')
    expect(html).not.toContain('github:d1')
  })

  it('filters by type', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events?type=incident.created'),
      env,
      ctx,
    )
    const html = await res.text()
    expect(html).toContain('statuspage:s1')
    expect(html).not.toContain('github:d1')
  })

  it('escapes HTML in title and type to prevent injection', async () => {
    bypassAccess()
    await env.EVENTS_DB.prepare(
      `INSERT INTO events (id, received_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
      .bind(
        'github:xss',
        '2026-06-06T13:00:00Z',
        SUB_HASH,
        '<script>',
        '<script>',
        '<script>',
        '<script>',
        'r2-key',
      )
      .run()
    const res = await worker.fetch(new Request('https://hooks.example.com/admin/events'), env, ctx)
    const html = await res.text()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('shows exhausted delivery state and redrives one sink', async () => {
    bypassAccess()
    const timestamp = '2026-06-06T12:05:00Z'
    await env.EVENTS_DB.prepare(
      'UPDATE events SET fanout_results = ? WHERE id = ?',
    )
      .bind(
        JSON.stringify({
          phone: {
            ok: true,
            status: 'delivered',
            attempts: 1,
            updatedAt: timestamp,
          },
        }),
        'github:d1',
      )
      .run()
    await env.EVENTS_DB.prepare(
      `INSERT INTO deliveries
       (event_id, sink_name, generation, status, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, 1, 'exhausted', 9, ?, ?, ?)`,
    )
      .bind('github:d1', 'phone', 'POST ntfy.sh -> 503', timestamp, timestamp)
      .run()

    const list = await worker.fetch(new Request('https://hooks.example.com/admin/events'), env, ctx)
    const html = await list.text()
    expect(html).toContain('phone: exhausted')
    expect(html).toContain('POST ntfy.sh -&gt; 503')
    expect(html).toContain('type="submit">Retry</button>')

    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const returnTo = '/admin/events?source=github&delivery=attention'
    const retry = await worker.fetch(
      new Request(`https://hooks.example.com/admin/events/github%3Ad1/deliveries/phone/retry?return_to=${encodeURIComponent(returnTo)}`, {
        method: 'POST',
        headers: { origin: 'https://hooks.example.com' },
      }),
      testEnv,
      ctx,
    )
    expect(retry.status).toBe(303)
    expect(retry.headers.get('location')).toBe(returnTo)
    expect(queue.messages).toEqual([
      { version: 1, eventId: 'github:d1', sinkName: 'phone', generation: 2 },
    ])

    const row = await env.EVENTS_DB.prepare(
      'SELECT status, attempts, last_error FROM deliveries WHERE event_id = ? AND sink_name = ?',
    )
      .bind('github:d1', 'phone')
      .first<{ status: string; attempts: number; last_error: string | null }>()
    expect(row).toEqual({ status: 'queued', attempts: 9, last_error: null })
  })

  it('rejects a cross-origin redrive request', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events/github%3Ad1/deliveries/phone/retry', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
  })

  it('rejects a redrive request without a browser Origin', async () => {
    bypassAccess()
    const res = await worker.fetch(
      new Request('https://hooks.example.com/admin/events/github%3Ad1/deliveries/phone/retry', {
        method: 'POST',
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
  })
})
