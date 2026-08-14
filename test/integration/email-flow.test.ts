import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
} from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DELIVERY_QUEUE_NAME } from '../../src/delivery'
import type { IncomingEmailMessage } from '../../src/email'
import worker, { type Env } from '../../src/index'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { normalizedR2Key } from '../../src/persistence'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'
import PLAIN_EMAIL from '../fixtures/email/plain.eml?raw'

const SUB_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2'
const SUB_KEY = await subscriptionKvKeyForSlug(SUB_SLUG)
const SINK_NAME = 'discord-email-fixture'
const DISCORD_SECRET = 'SINK_DISCORD_EMAIL_URL'
const DISCORD_URL = 'https://discord.example.test/webhook'

function incomingEmail(overrides: Partial<IncomingEmailMessage> = {}): IncomingEmailMessage {
  const bytes = new TextEncoder().encode(PLAIN_EMAIL)
  return {
    from: 'notifications@status.openai.com',
    to: `relay+${SUB_SLUG}@mail.example.com`,
    headers: new Headers(),
    raw: new Blob([bytes]).stream(),
    rawSize: bytes.byteLength,
    setReject: vi.fn(),
    ...overrides,
  }
}

function withSecret(baseEnv: Env): Env {
  return new Proxy(baseEnv, {
    get(target, property, receiver) {
      if (property === DISCORD_SECRET) return DISCORD_URL
      return Reflect.get(target, property, receiver)
    },
  })
}

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM deliveries; DELETE FROM events;')
  await env.SUBS.put(
    SUB_KEY,
    JSON.stringify({
      name: 'openai-status',
      source: 'email',
      enabled: true,
      sinks: [SINK_NAME],
      auth: null,
      email: { allowedSenders: ['@status.openai.com'] },
    }),
  )
  await env.SINKS.put(
    `sink:${SINK_NAME}`,
    JSON.stringify({ type: 'discord', urlEnv: DISCORD_SECRET }),
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  await env.SUBS.delete(SUB_KEY)
  await env.SINKS.delete(`sink:${SINK_NAME}`)
})

describe('end-to-end email flow', () => {
  it('persists raw MIME and delivers the normalized message to Discord', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    const queue = recordingQueue()
    const testEnv = withSecret(withDeliveryQueue(env as unknown as Env, queue.binding))
    const message = incomingEmail()

    await worker.email(message, testEnv, createExecutionContext())

    expect(message.setReject).not.toHaveBeenCalled()
    expect(queue.messages).toHaveLength(1)
    const eventRow = await env.EVENTS_DB.prepare(
      'SELECT id, source, sub_name, r2_key FROM events',
    ).first<{ id: string; source: string; sub_name: string; r2_key: string }>()
    expect(eventRow).toMatchObject({ source: 'email', sub_name: 'openai-status' })
    expect(eventRow?.id).toMatch(/^email:[a-f0-9]{64}:[a-f0-9]{64}$/)
    const rawObject = await env.EVENTS_RAW.get(eventRow!.r2_key)
    expect(await rawObject?.text()).toContain('Subject: Elevated errors for ChatGPT')
    expect(rawObject?.httpMetadata?.contentType).toBe('message/rfc822')
    const normalizedObject = await env.EVENTS_RAW.get(normalizedR2Key(eventRow!.r2_key))
    expect(await normalizedObject?.text()).not.toContain(SUB_SLUG)

    const batch = createMessageBatch(DELIVERY_QUEUE_NAME, [
      { id: 'email-flow-1', timestamp: new Date(), attempts: 1, body: queue.messages[0]! },
    ])
    const queueCtx = createExecutionContext()
    await worker.queue(batch, testEnv)
    const queueResult = await getQueueResult(batch, queueCtx)
    expect(queueResult.explicitAcks).toEqual(['email-flow-1'])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe(DISCORD_URL)
    const payload = JSON.parse(String(init?.body))
    expect(payload.embeds[0]).toMatchObject({
      title: 'Elevated errors for ChatGPT',
      url: 'https://status.openai.com/incidents/example',
      footer: { text: 'email / openai-status / email.received' },
    })
    expect(payload.embeds[0].description).toContain('We are investigating elevated errors')
    expect(payload.embeds[0].description).not.toContain('internal attachment')
  })

  it('rejects a sender outside the subscription allowlist without persisting', async () => {
    const queue = recordingQueue()
    const testEnv = withSecret(withDeliveryQueue(env as unknown as Env, queue.binding))
    const message = incomingEmail({ from: 'attacker@example.net' })

    await worker.email(message, testEnv, createExecutionContext())

    expect(message.setReject).toHaveBeenCalledWith('Sender not allowed')
    expect(queue.messages).toHaveLength(0)
    const count = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS count FROM events')
      .first<{ count: number }>()
    expect(count?.count).toBe(0)
  })

  it('rejects unknown routes and oversized messages before persistence', async () => {
    const queue = recordingQueue()
    const testEnv = withSecret(withDeliveryQueue(env as unknown as Env, queue.binding))
    const unknownCancel = vi.fn()
    const oversizedCancel = vi.fn()
    const unknown = incomingEmail({
      to: `relay+${'z'.repeat(22)}@mail.example.com`,
      raw: new ReadableStream({ cancel: unknownCancel }),
    })
    const oversized = incomingEmail({
      raw: new ReadableStream({ cancel: oversizedCancel }),
      rawSize: 1024 * 1024 + 1,
    })

    await worker.email(unknown, testEnv, createExecutionContext())
    await worker.email(oversized, testEnv, createExecutionContext())

    expect(unknown.setReject).toHaveBeenCalledWith('Unknown email route')
    expect(oversized.setReject).toHaveBeenCalledWith('Message too large')
    expect(unknownCancel).toHaveBeenCalledTimes(1)
    expect(oversizedCancel).toHaveBeenCalledTimes(1)
    expect(queue.messages).toHaveLength(0)
    const count = await env.EVENTS_DB.prepare('SELECT COUNT(*) AS count FROM events')
      .first<{ count: number }>()
    expect(count?.count).toBe(0)
  })

  it('accepts and drops mail for a disabled subscription', async () => {
    await env.SUBS.put(
      SUB_KEY,
      JSON.stringify({
        name: 'openai-status',
        source: 'email',
        enabled: false,
        sinks: [SINK_NAME],
        auth: null,
        email: { allowedSenders: [] },
      }),
    )
    const queue = recordingQueue()
    const testEnv = withSecret(withDeliveryQueue(env as unknown as Env, queue.binding))
    const cancel = vi.fn()
    const message = incomingEmail({ raw: new ReadableStream({ cancel }) })

    await worker.email(message, testEnv, createExecutionContext())

    expect(message.setReject).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(queue.messages).toHaveLength(0)
  })
})
