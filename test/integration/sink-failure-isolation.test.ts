import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import statuspageFixture from '../fixtures/statuspage/incident-investigating.json'

const SUB_SLUG = 'sf-isolation-aaaaaaaaaa'
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM events')
  await env.SUBS.put(
    `sub:${SUB_SLUG}`,
    JSON.stringify({
      name: 'sf-isolation',
      source: 'statuspage',
      enabled: true,
      sinks: ['ok-phone', 'broken-phone'],
      auth: null,
    }),
  )
  await env.SINKS.put(`sink:ok-phone`, JSON.stringify({ type: 'ntfy', topic: 't1' }))
  await env.SINKS.put(`sink:broken-phone`, JSON.stringify({ type: 'ntfy', topic: 't2' }))
})

afterEach(async () => {
  await env.SUBS.delete(`sub:${SUB_SLUG}`)
  await env.SINKS.delete(`sink:ok-phone`)
  await env.SINKS.delete(`sink:broken-phone`)
})

describe('sink failure isolation', () => {
  it('returns 200 to the sender even when one sink throws; D1 records both outcomes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url === 'https://ntfy.sh/t1') return new Response('ok', { status: 200 })
      if (url === 'https://ntfy.sh/t2') return new Response('boom', { status: 503 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const promises: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (p: Promise<unknown>) => promises.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/statuspage/${SUB_SLUG}`, {
        method: 'POST',
        body: JSON.stringify(statuspageFixture),
        headers: { 'content-type': 'application/json' },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    await Promise.all(promises)

    const row = await env.EVENTS_DB.prepare(
      'SELECT fanout_results FROM events WHERE id = ?',
    )
      .bind('statuspage:inc-001:upd-001')
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results['ok-phone']).toEqual({ ok: true })
    expect(results['broken-phone'].ok).toBe(false)
    expect(results['broken-phone'].errMsg).toMatch(/503/)
    fetchSpy.mockRestore()
  })
})
