import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import statuspageFixture from '../fixtures/statuspage/incident-investigating.json'

const SUB_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2statuspage'
const SINK_NAME = 'phone-fixture'

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM events')
  await env.SUBS.put(
    `sub:${SUB_SLUG}`,
    JSON.stringify({
      name: 'claude-status',
      source: 'statuspage',
      enabled: true,
      sinks: [SINK_NAME],
      auth: null,
    }),
  )
  await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({ type: 'ntfy', topic: 'flow-test' }))
})

afterEach(async () => {
  await env.SUBS.delete(`sub:${SUB_SLUG}`)
  await env.SINKS.delete(`sink:${SINK_NAME}`)
})

describe('end-to-end webhook flow', () => {
  it('persists event and fans out via ntfy sink', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith('https://ntfy.sh/')) {
        return new Response('ok', { status: 200 })
      }
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

    expect(fetchSpy).toHaveBeenCalled()
    const ntfyCall = fetchSpy.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : (input as Request).url).startsWith('https://ntfy.sh/'),
    )
    expect(ntfyCall).toBeDefined()

    const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind('statuspage:inc-001:upd-001')
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results[SINK_NAME]).toEqual({ ok: true })
    fetchSpy.mockRestore()
  })
})
