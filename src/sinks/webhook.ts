import { z } from 'zod'
import type { Sink } from '.'
import type { Env } from '../index'
import { hmacSha256Hex, sha256Hex } from '../lib/hmac'
import { postRaw } from '../lib/http'
import { normalizeWebhookEndpointUrl } from '../lib/public-url'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, SinkDeliveryContext } from '../types'

export const WEBHOOK_SINK_TYPE = 'webhook'
export const WEBHOOK_CONTENT_TYPE = 'application/cloudevents+json'
export const WEBHOOK_SIGNATURE_HEADER = 'X-Hookrelay-Signature-256'

const configSchema = z
  .object({
    urlEnv: z.string().min(1),
    signingSecretEnv: z.string().min(1),
  })
  .strict()

type Config = z.infer<typeof configSchema>

export async function webhookDeliveryId(eventId: string, sinkName: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify([eventId, sinkName])))
}

export async function webhookEnvelope(
  event: NormalizedEvent,
  context: SinkDeliveryContext,
): Promise<Record<string, unknown>> {
  const deliveryId = await webhookDeliveryId(context.eventId, context.sinkName)
  return {
    specversion: '1.0',
    id: deliveryId,
    source: `urn:hookrelay:source:${encodeURIComponent(event.source)}`,
    type: event.type,
    time: event.timestamp,
    subject: event.subName,
    data: {
      title: event.title,
      body: event.body,
      ...(event.url ? { url: event.url } : {}),
      severity: event.severity ?? 'info',
      source: event.source,
      subscription: event.subName,
      eventId: context.eventId,
      sinkName: context.sinkName,
      generation: context.generation,
      attempt: context.attempt,
    },
  }
}

const sink: Sink<Config> = {
  type: WEBHOOK_SINK_TYPE,
  configSchema,

  async send(event, config, env: Env, context, fetchFn) {
    const endpoint = normalizeWebhookEndpointUrl(readSecret(env, config.urlEnv))
    const signingSecret = readSecret(env, config.signingSecretEnv)
    const envelope = await webhookEnvelope(event, context)
    const body = JSON.stringify(envelope)
    const bodyBytes = new TextEncoder().encode(body)
    const deliveryId = envelope.id as string
    const signature = await hmacSha256Hex(signingSecret, bodyBytes)
    await postRaw(endpoint, body, {
      fetch: fetchFn,
      redirect: 'manual',
      errorLabel: 'webhook endpoint',
      includeResponseBody: false,
      headers: {
        'content-type': WEBHOOK_CONTENT_TYPE,
        'Idempotency-Key': deliveryId,
        'X-Hookrelay-Event-Id': context.eventId,
        'X-Hookrelay-Delivery-Id': deliveryId,
        [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
      },
    })
  },
}

export default sink
