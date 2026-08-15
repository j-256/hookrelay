import type { Adapter } from '.'
import type { Env } from '../index'
import {
  hmacSha256MatchesAny,
  parseHmacSha256Header,
  sha256Hex,
} from '../lib/hmac'
import { normalizeCloudEventUrl } from '../lib/public-url'
import { readOptionalSecret } from '../lib/secret'
import { SEVERITIES, type NormalizedEvent, type Severity, type Subscription } from '../types'

export const CLOUDEVENTS_SOURCE = 'cloudevents'
export const CLOUDEVENTS_AUTH_SCHEME = 'hookrelay-sha256'
export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json'
export const CLOUDEVENTS_SIGNATURE_HEADER = 'x-hookrelay-signature-256'
const RFC3339_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

interface StructuredCloudEvent {
  specversion: string
  id: string
  source: string
  type: string
  time?: string
  subject?: string
  title?: string
  severity?: string
  url?: string
  data?: unknown
  [key: string]: unknown
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function structuredContentType(request: Request): boolean {
  return request.headers.get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === CLOUDEVENTS_CONTENT_TYPE
}

function parseEnvelope(raw: Uint8Array): StructuredCloudEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw))
  } catch {
    throw new Error('CloudEvent body must be valid UTF-8 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CloudEvent body must be a JSON object')
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.specversion !== '1.0') throw new Error('CloudEvent specversion must be 1.0')
  for (const name of ['id', 'source', 'type'] as const) {
    if (!nonEmptyString(envelope[name])) throw new Error(`CloudEvent ${name} must be a non-empty string`)
  }
  if (envelope.time !== undefined) {
    if (
      !nonEmptyString(envelope.time) ||
      !RFC3339_TIMESTAMP_RE.test(envelope.time as string) ||
      !Number.isFinite(Date.parse(envelope.time as string))
    ) {
      throw new Error('CloudEvent time must be a valid timestamp')
    }
  }
  return envelope as StructuredCloudEvent
}

function dataBody(envelope: StructuredCloudEvent): string {
  if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) return ''
  return typeof envelope.data === 'string' ? envelope.data : JSON.stringify(envelope.data) ?? ''
}

function normalizedSeverity(value: unknown): Severity {
  return typeof value === 'string' && SEVERITIES.includes(value as Severity)
    ? value as Severity
    : 'info'
}

export async function normalizedCloudEventId(source: string, id: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify([source, id])))
}

const adapter: Adapter = {
  sourceType: CLOUDEVENTS_SOURCE,

  async verify(request: Request, raw: Uint8Array, sub: Subscription, env: Env): Promise<void> {
    if (!sub.auth || sub.auth.scheme !== CLOUDEVENTS_AUTH_SCHEME) {
      throw new Error(`CloudEvents adapter requires ${CLOUDEVENTS_AUTH_SCHEME} auth`)
    }
    const provided = parseHmacSha256Header(request.headers.get(CLOUDEVENTS_SIGNATURE_HEADER))
    if (!provided) throw new Error(`missing or invalid ${CLOUDEVENTS_SIGNATURE_HEADER}`)
    const secretEnvs = [sub.auth.secretEnv, ...(sub.auth.alternateSecretEnvs ?? [])]
    const secrets = secretEnvs
      .map((name) => readOptionalSecret(env, name))
      .filter((secret): secret is string => secret !== undefined)
    if (secrets.length === 0) throw new Error(`secret not set: ${secretEnvs.join(', ')}`)
    if (!(await hmacSha256MatchesAny(secrets, raw, provided))) {
      throw new Error('signature mismatch')
    }
  },

  async parse(request: Request, raw: Uint8Array, sub: Subscription): Promise<NormalizedEvent> {
    if (request.method !== 'POST') throw new Error('CloudEvents ingress requires POST')
    if (!structuredContentType(request)) {
      throw new Error(`CloudEvents ingress requires ${CLOUDEVENTS_CONTENT_TYPE}`)
    }
    const envelope = parseEnvelope(raw)
    const source = envelope.source.trim()
    const id = envelope.id.trim()
    const type = envelope.type.trim()
    let url: string | undefined
    if (typeof envelope.url === 'string') {
      try {
        url = normalizeCloudEventUrl(envelope.url)
      } catch {}
    }
    const title = nonEmptyString(envelope.title)
      ?? nonEmptyString(envelope.subject)
      ?? type
    return {
      source: CLOUDEVENTS_SOURCE,
      subName: sub.name,
      type,
      id: await normalizedCloudEventId(source, id),
      timestamp: envelope.time
        ? new Date(envelope.time).toISOString()
        : new Date().toISOString(),
      title,
      body: dataBody(envelope),
      ...(url ? { url } : {}),
      severity: normalizedSeverity(envelope.severity),
      raw: envelope,
    }
  },
}

export default adapter
