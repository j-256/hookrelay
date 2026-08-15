import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { DELIVERY_QUEUE_NAME } from '../../src/delivery'
import type { Env } from '../../src/index'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'
import statuspageFixture from '../fixtures/statuspage/incident-investigating.json'
import componentFixture from '../fixtures/statuspage/component-degraded.json'

const SUB_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2statuspage'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
const SINK_NAME = 'phone-fixture'

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(
    SUB_KEY,
    JSON.stringify({
      name: 'claude-status',
      source: 'statuspage',
      enabled: true,
      sinks: [SINK_NAME],
      auth: null,
      fallbackUrl: 'https://status.claude.com/',
    }),
  )
  await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({ type: 'ntfy', topic: 'flow-test' }))
})

afterEach(async () => {
  await env.SUBS.delete(SUB_KEY)
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

    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const ctx = createExecutionContext()

    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/statuspage/${SUB_SLUG}`, {
        method: 'POST',
        body: JSON.stringify(statuspageFixture),
        headers: { 'content-type': 'application/json' },
      }),
      testEnv,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(queue.messages).toHaveLength(1)

    const batch = createMessageBatch(DELIVERY_QUEUE_NAME, [
      { id: 'flow-1', timestamp: new Date(), attempts: 1, body: queue.messages[0]! },
    ])
    const queueCtx = createExecutionContext()
    await worker.queue(batch, testEnv)
    const queueResult = await getQueueResult(batch, queueCtx)
    expect(queueResult.explicitAcks).toEqual(['flow-1'])

    expect(fetchSpy).toHaveBeenCalled()
    const ntfyCall = fetchSpy.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : (input as Request).url).startsWith('https://ntfy.sh/'),
    )
    expect(ntfyCall).toBeDefined()
    const ntfyHeaders = new Headers(ntfyCall?.[1]?.headers)
    expect(ntfyHeaders.get('Click')).toBe('http://stspg.io/abc')

    const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind('statuspage:inc-001:upd-001')
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results[SINK_NAME]).toMatchObject({ ok: true, status: 'delivered', attempts: 1 })
    fetchSpy.mockRestore()
  })

  it('uses the configured status page for a component update without a shortlink', async () => {
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/statuspage/${SUB_SLUG}`, {
        method: 'POST',
        body: JSON.stringify(componentFixture),
        headers: { 'content-type': 'application/json' },
      }),
      testEnv,
      createExecutionContext(),
    )

    expect(res.status).toBe(200)
    const row = await env.EVENTS_DB.prepare('SELECT url FROM events WHERE id = ?')
      .bind('statuspage:cu-100')
      .first<{ url: string | null }>()
    expect(row?.url).toBe('https://status.claude.com/')
  })
})
