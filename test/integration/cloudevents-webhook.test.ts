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
import { hmacSha256Hex } from '../../src/lib/hmac'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import type { Env } from '../../src/index'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const SUB_SLUG = 'cloudevents-aaaaaaaaaa'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
const INGRESS_SECRET_ENV = 'HMAC_CLOUDEVENTS_FLOW'
const OUTBOUND_URL_ENV = 'SINK_WEBHOOK_FLOW_URL'
const OUTBOUND_SECRET_ENV = 'SINK_WEBHOOK_FLOW_SIGNING_SECRET'
const INGRESS_SECRET = 'ingress-flow-secret'
const OUTBOUND_SECRET = 'outbound-flow-secret'
const OUTBOUND_URL = 'https://receiver.example.com/events'
const SINK_NAME = 'webhook-flow'

const secretBindings = env as unknown as Record<string, string>
secretBindings[INGRESS_SECRET_ENV] = INGRESS_SECRET
secretBindings[OUTBOUND_URL_ENV] = OUTBOUND_URL
secretBindings[OUTBOUND_SECRET_ENV] = OUTBOUND_SECRET

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(SUB_KEY, JSON.stringify({
    name: 'generic-flow',
    source: 'cloudevents',
    enabled: true,
    sinks: [SINK_NAME],
    auth: { scheme: 'hookrelay-sha256', secretEnv: INGRESS_SECRET_ENV },
  }))
  await env.SINKS.put(`sink:${SINK_NAME}`, JSON.stringify({
    type: 'webhook',
    urlEnv: OUTBOUND_URL_ENV,
    signingSecretEnv: OUTBOUND_SECRET_ENV,
  }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await env.SUBS.delete(SUB_KEY)
  await env.SINKS.delete(`sink:${SINK_NAME}`)
})

async function ingressRequest(signatureSecret = INGRESS_SECRET): Promise<Request> {
  const body = JSON.stringify({
    specversion: '1.0',
    id: 'upstream-42',
    source: 'https://producer.example.com/orders',
    type: 'com.example.order.created',
    time: '2026-08-15T12:00:00Z',
    subject: 'Order 42',
    severity: 'critical',
    data: { orderId: 42 },
  })
  const signature = await hmacSha256Hex(signatureSecret, new TextEncoder().encode(body))
  return new Request(`https://hooks.example.com/hook/cloudevents/${SUB_SLUG}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/cloudevents+json',
      'x-hookrelay-signature-256': `sha256=${signature}`,
    },
    body,
  })
}

describe('signed CloudEvents ingress to webhook egress', () => {
  it('persists, queues, signs, and settles a generic event end to end', async () => {
    let outboundBody = ''
    let outboundHeaders = new Headers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(String(input)).toBe(OUTBOUND_URL)
      outboundBody = String(init?.body)
      outboundHeaders = new Headers(init?.headers)
      return new Response(null, { status: 204 })
    })
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const response = await worker.fetch(await ingressRequest(), testEnv, createExecutionContext())
    expect(response.status).toBe(200)
    const responseBody = await response.json<{ eventId: string }>()
    expect(responseBody.eventId).toMatch(/^cloudevents:[a-f0-9]{64}$/)
    expect(queue.messages).toHaveLength(1)

    const batch = createMessageBatch(DELIVERY_QUEUE_NAME, [{
      id: 'cloudevents-flow-1',
      timestamp: new Date(),
      attempts: 1,
      body: queue.messages[0]!,
    }])
    const queueContext = createExecutionContext()
    await worker.queue(batch, testEnv)
    expect((await getQueueResult(batch, queueContext)).explicitAcks).toEqual(['cloudevents-flow-1'])
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(outboundHeaders.get('X-Hookrelay-Event-Id')).toBe(responseBody.eventId)
    expect(outboundHeaders.get('X-Hookrelay-Signature-256')).toBe(
      `sha256=${await hmacSha256Hex(OUTBOUND_SECRET, new TextEncoder().encode(outboundBody))}`,
    )
    expect(JSON.parse(outboundBody)).toMatchObject({
      specversion: '1.0',
      type: 'com.example.order.created',
      subject: 'generic-flow',
      data: {
        severity: 'critical',
        eventId: responseBody.eventId,
        sinkName: SINK_NAME,
        generation: 1,
        attempt: 1,
      },
    })
    const delivery = await env.EVENTS_DB.prepare(
      'SELECT status, attempts FROM deliveries WHERE event_id = ? AND sink_name = ?',
    )
      .bind(responseBody.eventId, SINK_NAME)
      .first()
    expect(delivery).toEqual({ status: 'delivered', attempts: 1 })
  })

  it('rejects an invalid signature without persistence or queue publication', async () => {
    const queue = recordingQueue()
    const testEnv = withDeliveryQueue(env as unknown as Env, queue.binding)
    const response = await worker.fetch(
      await ingressRequest('wrong-secret'),
      testEnv,
      createExecutionContext(),
    )
    expect(response.status).toBe(401)
    expect(queue.messages).toEqual([])
    const events = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS count FROM events').first<{ count: number }>()
    expect(events?.count).toBe(0)
  })
})
