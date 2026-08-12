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

const SUB_SLUG = 'sf-isolation-aaaaaaaaaa'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(
    SUB_KEY,
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
  await env.SUBS.delete(SUB_KEY)
  await env.SINKS.delete(`sink:ok-phone`)
  await env.SINKS.delete(`sink:broken-phone`)
})

describe('sink failure isolation', () => {
  it('returns 200 after durable enqueue, then records each independent outcome', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url === 'https://ntfy.sh/t1') return new Response('ok', { status: 200 })
      if (url === 'https://ntfy.sh/t2') return new Response('boom', { status: 503 })
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
    expect(queue.messages).toHaveLength(2)

    const batch = createMessageBatch(
      DELIVERY_QUEUE_NAME,
      queue.messages.map((body, index) => ({
        id: `isolation-${index}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    )
    const queueCtx = createExecutionContext()
    await worker.queue(batch, testEnv)
    const queueResult = await getQueueResult(batch, queueCtx)
    expect(queueResult.explicitAcks).toHaveLength(1)
    expect(queueResult.retryMessages).toHaveLength(1)

    const row = await env.EVENTS_DB.prepare(
      'SELECT fanout_results FROM events WHERE id = ?',
    )
      .bind('statuspage:inc-001:upd-001')
      .first<{ fanout_results: string }>()
    const results = JSON.parse(row?.fanout_results ?? '{}')
    expect(results['ok-phone']).toMatchObject({ ok: true, status: 'delivered', attempts: 1 })
    expect(results['broken-phone']).toMatchObject({ ok: false, status: 'retrying', attempts: 1 })
    expect(results['broken-phone'].errMsg).toMatch(/503/)
    fetchSpy.mockRestore()
  })
})
