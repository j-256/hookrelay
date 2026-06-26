import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM events')

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
      .bind(e.id, e.received_at, 'slug', e.sub_name, e.source, e.type, e.title, `events/2026/06/06/${e.id.replace(':', '_')}.raw`)
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
        'slug',
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
})
