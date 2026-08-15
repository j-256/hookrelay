import { describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import webhook, {
  WEBHOOK_CONTENT_TYPE,
  webhookDeliveryId,
} from '../../../src/sinks/webhook'
import type { Env } from '../../../src/index'
import type { NormalizedEvent, SinkDeliveryContext } from '../../../src/types'

const URL_ENV = 'SINK_GENERIC_URL'
const SIGNING_ENV = 'SINK_GENERIC_SIGNING_SECRET'
const ENDPOINT = 'https://receiver.example.com/hooks?tenant=hookrelay'
const SIGNING_SECRET = 'outbound-signing-secret'
const testEnv = {
  [URL_ENV]: ENDPOINT,
  [SIGNING_ENV]: SIGNING_SECRET,
} as unknown as Env
const event: NormalizedEvent = {
  source: 'cloudevents',
  subName: 'orders',
  type: 'com.example.order.created',
  id: 'normalized-id',
  timestamp: '2026-08-15T12:00:00.000Z',
  title: 'Order created',
  body: '{"orderId":42}',
  url: 'https://app.example.com/orders/42',
  severity: 'warning',
  raw: {},
}
const context: SinkDeliveryContext = {
  eventId: 'cloudevents:normalized-id',
  sinkName: 'generic',
  generation: 3,
  attempt: 2,
}

describe('signed webhook sink', () => {
  it('signs the exact structured CloudEvent body and sends stable delivery metadata', async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(ENDPOINT)
      expect(init?.redirect).toBe('manual')
      const body = String(init?.body)
      const headers = new Headers(init?.headers)
      const expectedDeliveryId = await webhookDeliveryId(context.eventId, context.sinkName)
      expect(headers.get('content-type')).toBe(WEBHOOK_CONTENT_TYPE)
      expect(headers.get('Idempotency-Key')).toBe(expectedDeliveryId)
      expect(headers.get('X-Hookrelay-Event-Id')).toBe(context.eventId)
      expect(headers.get('X-Hookrelay-Delivery-Id')).toBe(expectedDeliveryId)
      expect(headers.get('X-Hookrelay-Signature-256')).toBe(
        `sha256=${await hmacSha256Hex(SIGNING_SECRET, new TextEncoder().encode(body))}`,
      )
      expect(JSON.parse(body)).toEqual({
        specversion: '1.0',
        id: expectedDeliveryId,
        source: 'urn:hookrelay:source:cloudevents',
        type: event.type,
        time: event.timestamp,
        subject: event.subName,
        data: {
          title: event.title,
          body: event.body,
          url: event.url,
          severity: 'warning',
          source: event.source,
          subscription: event.subName,
          eventId: context.eventId,
          sinkName: context.sinkName,
          generation: 3,
          attempt: 2,
        },
      })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await webhook.send(
      event,
      { urlEnv: URL_ENV, signingSecretEnv: SIGNING_ENV },
      testEnv,
      context,
      fetchMock,
    )
  })

  it('keeps the idempotency key stable across automatic and manual retries', async () => {
    const keys: string[] = []
    const fetchMock = vi.fn(async (_input: Request | string | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('Idempotency-Key')!)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const config = { urlEnv: URL_ENV, signingSecretEnv: SIGNING_ENV }
    await webhook.send(event, config, testEnv, context, fetchMock)
    await webhook.send(event, config, testEnv, { ...context, generation: 4, attempt: 7 }, fetchMock)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
  })

  it('rejects redirects and unsafe endpoint URLs', async () => {
    const redirectingFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.com' },
    })) as unknown as typeof fetch
    await expect(webhook.send(
      event,
      { urlEnv: URL_ENV, signingSecretEnv: SIGNING_ENV },
      testEnv,
      context,
      redirectingFetch,
    )).rejects.toMatchObject({ status: 302 })

    for (const endpoint of [
      'http://receiver.example.com/hooks',
      'https://user:pass@receiver.example.com/hooks',
      'https://receiver.example.com/hooks#secret',
      'https://localhost/hooks',
    ]) {
      const unsafeEnv = { ...testEnv as unknown as Record<string, unknown>, [URL_ENV]: endpoint } as unknown as Env
      await expect(webhook.send(
        event,
        { urlEnv: URL_ENV, signingSecretEnv: SIGNING_ENV },
        unsafeEnv,
        context,
        vi.fn() as unknown as typeof fetch,
      )).rejects.toThrow(/webhook endpoint URL/)
    }
  })

  it('requires both secret references in strict configuration', () => {
    expect(() => webhook.configSchema.parse({ urlEnv: URL_ENV, signingSecretEnv: SIGNING_ENV })).not.toThrow()
    expect(() => webhook.configSchema.parse({ urlEnv: URL_ENV })).toThrow()
    expect(() => webhook.configSchema.parse({
      urlEnv: URL_ENV,
      signingSecretEnv: SIGNING_ENV,
      url: ENDPOINT,
    })).toThrow()
  })
})
