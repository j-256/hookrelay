import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_DLQ_NAME,
  DELIVERY_QUEUE_NAME,
  enqueuePendingDeliveries,
  handleDeadLetterBatch,
  handleDeliveryBatch,
  prepareDeliveries,
  redriveDelivery,
  retryDelaySeconds,
} from '../../src/delivery'
import type { Env } from '../../src/index'
import { HttpError } from '../../src/lib/http'
import { registerSink } from '../../src/sinks'
import type { Sink } from '../../src/sinks'
import type { DeliveryMessage, FanoutResults, NormalizedEvent } from '../../src/types'
import { z } from 'zod'

const EVENT_ID = 'fixture:evt-1'
const R2_RAW_KEY = 'events/2026/06/06/fixture_evt-1.raw'
const SINK_NAME = 'delivery-test'

const event: NormalizedEvent = {
  source: 'fixture',
  subName: 'fixture-sub',
  type: 'fixture.event',
  id: 'evt-1',
  timestamp: '2026-06-06T00:00:00.000Z',
  title: 'delivery test',
  body: 'body',
  raw: {},
}

const sendSpy = vi.fn(async () => {})
const failSpy = vi.fn(async () => {
  throw new HttpError('rate limited', 429, 120)
})

const okSink: Sink<{}> = {
  type: 'delivery-ok',
  configSchema: z.object({}).strict(),
  send: sendSpy,
}
const failSink: Sink<{}> = {
  type: 'delivery-fail',
  configSchema: z.object({}).strict(),
  send: failSpy,
}

interface RecordingQueue {
  binding: Queue<DeliveryMessage>
  messages: DeliveryMessage[]
  sendBatch: ReturnType<typeof vi.fn>
}

function recordingQueue(error?: Error): RecordingQueue {
  const messages: DeliveryMessage[] = []
  const sendBatch = vi.fn(async (requests: Iterable<MessageSendRequest<DeliveryMessage>>) => {
    if (error) throw error
    for (const request of requests) messages.push(request.body)
    return {
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    }
  })
  return {
    binding: { sendBatch } as unknown as Queue<DeliveryMessage>,
    messages,
    sendBatch,
  }
}

function withQueue(queue: Queue<DeliveryMessage>): Env {
  return new Proxy(env as unknown as Env, {
    get(target, property, receiver) {
      if (property === 'DELIVERY_QUEUE') return queue
      return Reflect.get(target, property, receiver)
    },
  })
}

async function seedEvent(): Promise<void> {
  await env.EVENTS_DB.prepare(
    `INSERT INTO events
     (id, received_at, sender_at, sub_slug, sub_name, source, type, title, r2_key, fanout_results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
    .bind(
      EVENT_ID,
      '2026-06-06T00:00:00.000Z',
      event.timestamp,
      'slug',
      event.subName,
      event.source,
      event.type,
      event.title,
      R2_RAW_KEY,
    )
    .run()
  await env.EVENTS_RAW.put(R2_RAW_KEY.replace(/\.raw$/, '.json'), JSON.stringify(event))
}

async function deliveryRow(): Promise<{
  status: string
  generation: number
  attempts: number
  last_error: string | null
}> {
  const row = await env.EVENTS_DB.prepare(
    'SELECT status, generation, attempts, last_error FROM deliveries WHERE event_id = ? AND sink_name = ?',
  )
    .bind(EVENT_ID, SINK_NAME)
    .first<{ status: string; generation: number; attempts: number; last_error: string | null }>()
  if (!row) throw new Error('delivery row missing')
  return row
}

async function fanoutResult(): Promise<FanoutResults[string]> {
  const row = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
    .bind(EVENT_ID)
    .first<{ fanout_results: string }>()
  return (JSON.parse(row?.fanout_results ?? '{}') as FanoutResults)[SINK_NAME]!
}

function deliveryBatch(message: DeliveryMessage, attempts = 1) {
  return createMessageBatch(DELIVERY_QUEUE_NAME, [
    { id: `delivery-${attempts}`, timestamp: new Date(), attempts, body: message },
  ])
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  for (const sink of [okSink, failSink]) {
    try { registerSink(sink) } catch {}
  }
})

beforeEach(async () => {
  sendSpy.mockClear()
  failSpy.mockClear()
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({ type: 'delivery-ok' }))
  await seedEvent()
})

describe('durable delivery', () => {
  it('creates one delivery row and one small queue message per sink', async () => {
    const queue = recordingQueue()
    const result = await prepareDeliveries(withQueue(queue.binding), EVENT_ID, [SINK_NAME])

    expect(result).toEqual({ queued: 1, deferred: 0 })
    expect(queue.messages).toEqual([
      { version: 1, eventId: EVENT_ID, sinkName: SINK_NAME, generation: 1 },
    ])
    expect(await deliveryRow()).toMatchObject({ status: 'queued', generation: 1, attempts: 0 })
    expect(await fanoutResult()).toMatchObject({ ok: false, status: 'queued', attempts: 0 })
  })

  it.each([
    [true, 'delivered'],
    [false, 'exhausted'],
  ] as const)('imports a legacy ok=%s result as %s without resending it', async (ok, status) => {
    await env.EVENTS_DB.prepare('UPDATE events SET fanout_results = ? WHERE id = ?')
      .bind(JSON.stringify({
        [SINK_NAME]: {
          ok,
          attempts: 3,
          ...(ok ? {} : { errMsg: 'legacy failure' }),
        },
      }), EVENT_ID)
      .run()
    const queue = recordingQueue()

    await expect(
      prepareDeliveries(withQueue(queue.binding), EVENT_ID, [SINK_NAME]),
    ).resolves.toEqual({ queued: 0, deferred: 0 })

    expect(queue.messages).toEqual([])
    expect(await deliveryRow()).toMatchObject({ status, generation: 0, attempts: 3 })
  })

  it('delivers and acknowledges a queued sink independently', async () => {
    const queue = recordingQueue()
    const testEnv = withQueue(queue.binding)
    await prepareDeliveries(testEnv, EVENT_ID, [SINK_NAME])
    const batch = deliveryBatch(queue.messages[0]!)
    const ctx = createExecutionContext()

    await handleDeliveryBatch(batch, testEnv)
    const result = await getQueueResult(batch, ctx)

    expect(result.explicitAcks).toEqual(['delivery-1'])
    expect(result.retryMessages).toEqual([])
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', attempts: 1, last_error: null })
    expect(await fanoutResult()).toMatchObject({ ok: true, status: 'delivered', attempts: 1 })
  })

  it('records a failed attempt and honors Retry-After when retrying', async () => {
    await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({ type: 'delivery-fail' }))
    const queue = recordingQueue()
    const testEnv = withQueue(queue.binding)
    await prepareDeliveries(testEnv, EVENT_ID, [SINK_NAME])
    const batch = deliveryBatch(queue.messages[0]!)
    const ctx = createExecutionContext()

    await handleDeliveryBatch(batch, testEnv)
    const result = await getQueueResult(batch, ctx)

    expect(result.explicitAcks).toEqual([])
    expect(result.retryMessages).toEqual([{ msgId: 'delivery-1' }])
    expect(retryDelaySeconds(1, 120)).toBe(120)
    expect(await deliveryRow()).toMatchObject({ status: 'retrying', attempts: 1, last_error: 'rate limited' })
    expect(await fanoutResult()).toMatchObject({ ok: false, status: 'retrying', attempts: 1, errMsg: 'rate limited' })
  })

  it('leaves delivery intent pending when queue publication fails, then sweeps it', async () => {
    const unavailable = recordingQueue(new Error('queue unavailable'))
    const deferred = await prepareDeliveries(withQueue(unavailable.binding), EVENT_ID, [SINK_NAME])

    expect(deferred).toEqual({ queued: 0, deferred: 1 })
    expect(await deliveryRow()).toMatchObject({ status: 'pending', generation: 1 })
    expect(await fanoutResult()).toMatchObject({ status: 'pending' })

    const recovered = recordingQueue()
    await expect(enqueuePendingDeliveries(withQueue(recovered.binding))).resolves.toEqual({ queued: 1, deferred: 0 })
    expect(recovered.messages).toEqual([
      { version: 1, eventId: EVENT_ID, sinkName: SINK_NAME, generation: 2 },
    ])
    expect(await deliveryRow()).toMatchObject({ status: 'queued', generation: 2 })
  })

  it('invalidates an uncertain earlier publish before recovery republishes it', async () => {
    const queue = recordingQueue()
    const testEnv = withQueue(queue.binding)
    await prepareDeliveries(testEnv, EVENT_ID, [SINK_NAME])

    await env.EVENTS_DB.prepare(
      `UPDATE deliveries SET status = 'pending'
       WHERE event_id = ? AND sink_name = ?`,
    )
      .bind(EVENT_ID, SINK_NAME)
      .run()
    await enqueuePendingDeliveries(testEnv)

    expect(queue.messages.map((message) => message.generation)).toEqual([1, 2])

    const stale = deliveryBatch(queue.messages[0]!)
    const staleCtx = createExecutionContext()
    await handleDeliveryBatch(stale, testEnv)
    expect((await getQueueResult(stale, staleCtx)).explicitAcks).toEqual(['delivery-1'])
    expect(sendSpy).not.toHaveBeenCalled()

    const current = deliveryBatch(queue.messages[1]!)
    await handleDeliveryBatch(current, testEnv)
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', generation: 2 })
  })

  it('suppresses a duplicate queue message after success', async () => {
    const queue = recordingQueue()
    const testEnv = withQueue(queue.binding)
    await prepareDeliveries(testEnv, EVENT_ID, [SINK_NAME])
    const message = queue.messages[0]!

    const first = deliveryBatch(message)
    await handleDeliveryBatch(first, testEnv)
    const duplicate = deliveryBatch(message, 2)
    const ctx = createExecutionContext()
    await handleDeliveryBatch(duplicate, testEnv)
    const result = await getQueueResult(duplicate, ctx)

    expect(result.explicitAcks).toEqual(['delivery-2'])
    expect(sendSpy).toHaveBeenCalledOnce()
    expect(await deliveryRow()).toMatchObject({ status: 'delivered', attempts: 1 })
  })

  it('acknowledges malformed internal messages without dispatching them', async () => {
    const batch = createMessageBatch(DELIVERY_QUEUE_NAME, [
      {
        id: 'delivery-invalid',
        timestamp: new Date(),
        attempts: 1,
        body: { version: 1, eventId: EVENT_ID, sinkName: SINK_NAME },
      },
    ])
    const ctx = createExecutionContext()

    await handleDeliveryBatch(batch, env as unknown as Env)
    const result = await getQueueResult(batch, ctx)

    expect(result.explicitAcks).toEqual(['delivery-invalid'])
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('marks a dead-lettered delivery exhausted and redrives it', async () => {
    await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({ type: 'delivery-fail' }))
    const queue = recordingQueue()
    const testEnv = withQueue(queue.binding)
    await prepareDeliveries(testEnv, EVENT_ID, [SINK_NAME])
    const primary = deliveryBatch(queue.messages[0]!)
    await handleDeliveryBatch(primary, testEnv)

    const dlq = createMessageBatch(DELIVERY_DLQ_NAME, [
      { id: 'dead-1', timestamp: new Date(), attempts: 1, body: queue.messages[0]! },
    ])
    const dlqCtx = createExecutionContext()
    await handleDeadLetterBatch(dlq, testEnv)
    const dlqResult = await getQueueResult(dlq, dlqCtx)

    expect(dlqResult.explicitAcks).toEqual(['dead-1'])
    expect(await deliveryRow()).toMatchObject({ status: 'exhausted', attempts: 1 })
    expect(await fanoutResult()).toMatchObject({ status: 'exhausted' })

    const redriveQueue = recordingQueue()
    await expect(redriveDelivery(withQueue(redriveQueue.binding), EVENT_ID, SINK_NAME)).resolves.toEqual({ ok: true })
    expect(redriveQueue.messages).toHaveLength(1)
    expect(redriveQueue.messages[0]).toMatchObject({ generation: 2 })
    expect(await deliveryRow()).toMatchObject({ status: 'queued', generation: 2, attempts: 1, last_error: null })

    const staleDlq = createMessageBatch(DELIVERY_DLQ_NAME, [
      { id: 'dead-stale', timestamp: new Date(), attempts: 2, body: queue.messages[0]! },
    ])
    const staleCtx = createExecutionContext()
    await handleDeadLetterBatch(staleDlq, testEnv)
    const staleResult = await getQueueResult(staleDlq, staleCtx)

    expect(staleResult.explicitAcks).toEqual(['dead-stale'])
    expect(await deliveryRow()).toMatchObject({ status: 'queued', generation: 2 })
  })
})
