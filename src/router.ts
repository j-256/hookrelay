import { getAdapter } from './adapters'
import { ingestEvent } from './ingest'
import { withSubscriptionFallbackUrl } from './lib/event-url'
import { hashSubscriptionSlug, SUBSCRIPTION_SLUG_PATTERN, subscriptionKvKey } from './lib/subscription'
import { recordOperationalSignal } from './operations'
import { primaryKey } from './persistence'
import type { Env } from './index'
import type { Subscription } from './types'

export const SLUG_PATH_RE = new RegExp(`^/hook/[a-z0-9-]+/${SUBSCRIPTION_SLUG_PATTERN}$`)
const HOOK_PATH_RE = new RegExp(`^/hook/([a-z0-9-]+)/(${SUBSCRIPTION_SLUG_PATTERN})$`)
const MAX_BODY_BYTES = 1024 * 1024

export interface ParsedHookPath {
  sourceType: string
  slug: string
}

export function parseHookPath(pathname: string): ParsedHookPath | null {
  const m = HOOK_PATH_RE.exec(pathname)
  if (!m) return null
  return { sourceType: m[1]!, slug: m[2]! }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handleHook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url)
  const parsed = parseHookPath(url.pathname)
  if (!parsed) return new Response('not found', { status: 404 })
  const { sourceType, slug } = parsed
  const slugHash = await hashSubscriptionSlug(slug)

  const subRaw = await env.SUBS.get(subscriptionKvKey(slugHash))
  if (!subRaw) return new Response('not found', { status: 404 })
  let sub: Subscription
  try {
    sub = JSON.parse(subRaw) as Subscription
  } catch {
    console.log(JSON.stringify({ level: 'error', msg: 'sub.json.invalid' }))
    return new Response('internal error', { status: 500 })
  }

  if (sub.source !== sourceType) return new Response('not found', { status: 404 })
  if (!sub.enabled) return new Response(null, { status: 204 })

  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) {
    await recordOperationalSignal(env, {
      code: 'ingress-payload-too-large',
      source: sub.source,
      subName: sub.name,
    })
    return new Response('payload too large', { status: 413 })
  }

  const rawBody = new Uint8Array(await request.arrayBuffer())
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    await recordOperationalSignal(env, {
      code: 'ingress-payload-too-large',
      source: sub.source,
      subName: sub.name,
    })
    return new Response('payload too large', { status: 413 })
  }

  const adapter = getAdapter(sourceType)
  if (!adapter) {
    await recordOperationalSignal(env, {
      code: 'ingress-adapter-missing',
      source: sub.source,
      subName: sub.name,
    })
    console.log(JSON.stringify({ level: 'error', msg: 'adapter.missing', sourceType }))
    return new Response('internal error', { status: 500 })
  }

  try {
    await adapter.verify(request, rawBody, sub, env)
  } catch {
    await recordOperationalSignal(env, {
      code: 'ingress-authentication-rejected',
      source: sub.source,
      subName: sub.name,
    })
    console.log(JSON.stringify({ level: 'warn', msg: 'verify.rejected', sourceType }))
    return new Response('unauthorized', { status: 401 })
  }

  let event
  try {
    event = await adapter.parse(request, rawBody, sub)
    event = withSubscriptionFallbackUrl(event, sub)
  } catch {
    await recordOperationalSignal(env, {
      code: 'ingress-parse-rejected',
      source: sub.source,
      subName: sub.name,
    })
    console.log(JSON.stringify({ level: 'warn', msg: 'parse.failed', sourceType }))
    return new Response('unprocessable entity', { status: 422 })
  }

  const contentType = request.headers.get('content-type') ?? 'application/octet-stream'
  let ingested
  try {
    ingested = await ingestEvent(env, event, rawBody, contentType, slugHash, sub)
  } catch {
    await recordOperationalSignal(env, {
      code: 'ingress-persistence-rejected',
      source: sub.source,
      subName: sub.name,
      eventId: primaryKey(event),
    })
    console.log(JSON.stringify({ level: 'error', msg: 'ingress.persistence.rejected' }))
    return new Response('internal error', { status: 500 })
  }

  // Sender gets 200 after the event and all per-sink delivery intents are durable
  return json({
    ok: true,
    eventId: ingested.eventId,
    ...(ingested.duplicate ? { duplicate: true } : {}),
  }, 200)
}
