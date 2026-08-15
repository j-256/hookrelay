import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import cloudevents, {
  CLOUDEVENTS_CONTENT_TYPE,
  normalizedCloudEventId,
} from '../../../src/adapters/cloudevents'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import type { Subscription } from '../../../src/types'

const SECRET_ENV = 'HMAC_CLOUDEVENTS_TEST'
const ALTERNATE_ENV = 'HMAC_CLOUDEVENTS_TEST_NEXT'
const SECRET = 'primary-cloud-events-secret'
const ALTERNATE = 'alternate-cloud-events-secret'
const subscription: Subscription = {
  name: 'generic-events',
  source: 'cloudevents',
  enabled: true,
  sinks: ['webhook'],
  auth: { scheme: 'hookrelay-sha256', secretEnv: SECRET_ENV },
}

;(env as unknown as Record<string, string>)[SECRET_ENV] = SECRET
;(env as unknown as Record<string, string>)[ALTERNATE_ENV] = ALTERNATE

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: 'provider-event-1',
    source: 'https://events.example.com/orders',
    type: 'com.example.order.created',
    time: '2026-08-15T12:00:00Z',
    subject: 'Order 42',
    severity: 'error',
    url: 'https://app.example.com/orders/42?view=event',
    data: { orderId: 42, state: 'created' },
    ...overrides,
  }
}

async function signedRequest(
  value: Record<string, unknown>,
  secret = SECRET,
): Promise<{ request: Request; raw: Uint8Array }> {
  const body = JSON.stringify(value)
  const raw = new TextEncoder().encode(body)
  const signature = await hmacSha256Hex(secret, raw)
  return {
    request: new Request('https://hooks.example.com/hook/cloudevents/opaque', {
      method: 'POST',
      headers: {
        'content-type': `${CLOUDEVENTS_CONTENT_TYPE}; charset=utf-8`,
        'x-hookrelay-signature-256': `sha256=${signature}`,
      },
      body,
    }),
    raw,
  }
}

describe('CloudEvents adapter authentication', () => {
  it('verifies the exact body with primary and alternate HMAC secrets', async () => {
    const primary = await signedRequest(envelope())
    await expect(cloudevents.verify(primary.request, primary.raw, subscription, env))
      .resolves.toBeUndefined()

    const alternate = await signedRequest(envelope(), ALTERNATE)
    const rotating = {
      ...subscription,
      auth: {
        scheme: 'hookrelay-sha256',
        secretEnv: SECRET_ENV,
        alternateSecretEnvs: [ALTERNATE_ENV],
      },
    }
    await expect(cloudevents.verify(alternate.request, alternate.raw, rotating, env))
      .resolves.toBeUndefined()
  })

  it('rejects malformed, uppercase, and mismatched signatures', async () => {
    const signed = await signedRequest(envelope())
    const uppercase = new Request(signed.request, {
      headers: {
        ...Object.fromEntries(signed.request.headers),
        'x-hookrelay-signature-256': signed.request.headers
          .get('x-hookrelay-signature-256')!
          .toUpperCase(),
      },
    })
    await expect(cloudevents.verify(uppercase, signed.raw, subscription, env)).rejects.toThrow(/signature/i)

    const mismatched = await signedRequest(envelope({ id: 'changed' }))
    await expect(cloudevents.verify(mismatched.request, signed.raw, subscription, env)).rejects.toThrow(/signature/i)
  })
})

describe('CloudEvents adapter normalization', () => {
  it('normalizes required attributes, extensions, and compact JSON data', async () => {
    const signed = await signedRequest(envelope())
    const event = await cloudevents.parse(signed.request, signed.raw, subscription)
    expect(event).toEqual({
      source: 'cloudevents',
      subName: 'generic-events',
      type: 'com.example.order.created',
      id: await normalizedCloudEventId('https://events.example.com/orders', 'provider-event-1'),
      timestamp: '2026-08-15T12:00:00.000Z',
      title: 'Order 42',
      body: '{"orderId":42,"state":"created"}',
      url: 'https://app.example.com/orders/42?view=event',
      severity: 'error',
      raw: envelope(),
    })
  })

  it('uses safe defaults and omits a non-public URL', async () => {
    const value = envelope({
      time: undefined,
      subject: undefined,
      title: undefined,
      severity: 'emergency',
      url: 'https://127.0.0.1/private',
      data: 'plain text',
    })
    const signed = await signedRequest(value)
    const before = Date.now()
    const event = await cloudevents.parse(signed.request, signed.raw, subscription)
    expect(Date.parse(event.timestamp)).toBeGreaterThanOrEqual(before)
    expect(event).toMatchObject({
      title: 'com.example.order.created',
      body: 'plain text',
      severity: 'info',
    })
    expect(event).not.toHaveProperty('url')
  })

  it('rejects unsupported or malformed structured envelopes', async () => {
    for (const value of [
      envelope({ specversion: '0.3' }),
      envelope({ id: '' }),
      envelope({ time: 'not-a-time' }),
      envelope({ time: '2026-08-15' }),
    ]) {
      const signed = await signedRequest(value)
      await expect(cloudevents.parse(signed.request, signed.raw, subscription)).rejects.toThrow(/CloudEvent/)
    }

    const signed = await signedRequest(envelope())
    const wrongContentType = new Request(signed.request, {
      headers: {
        ...Object.fromEntries(signed.request.headers),
        'content-type': 'application/json',
      },
    })
    await expect(cloudevents.parse(wrongContentType, signed.raw, subscription)).rejects.toThrow(/content|requires/i)
  })
})
