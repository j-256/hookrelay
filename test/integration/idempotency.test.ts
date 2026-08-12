import { applyD1Migrations, createExecutionContext, createMessageBatch, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { DELIVERY_QUEUE_NAME } from '../../src/delivery'
import type { Env } from '../../src/index'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'
import statuspageFixture from '../fixtures/statuspage/incident-investigating.json'

const SUB_SLUG = 'idemp-aaaaaaaaaaaaaaaaaa'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(
    SUB_KEY,
    JSON.stringify({ name: 'idemp', source: 'statuspage', enabled: true, sinks: ['t-sink'], auth: null }),
  )
  await env.SINKS.put('sink:t-sink', JSON.stringify({ type: 'ntfy', topic: 'idemp' }))
})

afterEach(async () => {
  await env.SUBS.delete(SUB_KEY)
  await env.SINKS.delete('sink:t-sink')
})

describe('idempotency', () => {
  it('second POST returns duplicate:true and does not enqueue another delivery', async () => {
    const calls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      calls.push(url)
      return new Response('ok', { status: 200 })
    })
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const post = async () => {
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
      return res
    }

    const first = await post()
    expect(first.status).toBe(200)
    expect(await first.json<{ duplicate?: boolean }>()).not.toHaveProperty('duplicate')

    const second = await post()
    expect(second.status).toBe(200)
    expect((await second.json<{ duplicate?: boolean }>()).duplicate).toBe(true)
    expect(queue.messages).toHaveLength(1)

    const batch = createMessageBatch(DELIVERY_QUEUE_NAME, [
      { id: 'idempotency-1', timestamp: new Date(), attempts: 1, body: queue.messages[0]! },
    ])
    await worker.queue(batch, testEnv)

    // The duplicate request does not create a second sink request
    const ntfyCalls = calls.filter((u) => u.startsWith('https://ntfy.sh/'))
    expect(ntfyCalls).toHaveLength(1)
    fetchSpy.mockRestore()
  })
})
