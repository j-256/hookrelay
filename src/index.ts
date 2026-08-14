import './registry'
import { handleAdminEvents, handleAdminRaw, handleAdminRetry } from './admin/events'
import {
  enqueuePendingDeliveries,
  handleQueueBatch,
} from './delivery'
import { handleEmail, type IncomingEmailMessage } from './email'
import { handleHook } from './router'
import type { DeliveryMessage } from './types'

const ADMIN_ROOT_PATH = '/admin'
const ADMIN_EVENTS_PATH = '/admin/events'

export interface Env {
  SUBS: KVNamespace
  SINKS: KVNamespace
  EVENTS_DB: D1Database
  EVENTS_RAW: R2Bucket
  DELIVERY_QUEUE: Queue<DeliveryMessage>
  CF_ACCESS_TEAM_DOMAIN: string
  CF_ACCESS_AUD: string
  /** JSON binding injected by tests via cloudflareTest() miniflare.bindings */
  TEST_MIGRATIONS?: { name: string; queries: string[] }[]
  /** Set to '1' in test env to bypass CF Access JWT verification; never set in production */
  TEST_BYPASS_ACCESS?: string
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/hook/')) {
      return handleHook(request, env, ctx)
    }
    if (url.pathname === ADMIN_ROOT_PATH) {
      url.pathname = ADMIN_EVENTS_PATH
      return Response.redirect(url.toString())
    }
    if (url.pathname === ADMIN_EVENTS_PATH) {
      return handleAdminEvents(request, env)
    }
    const rawMatch = /^\/admin\/events\/([^/]+)\/raw$/.exec(url.pathname)
    if (rawMatch) {
      let eventId: string
      try {
        eventId = decodeURIComponent(rawMatch[1]!)
      } catch {
        return new Response('not found', { status: 404 })
      }
      return handleAdminRaw(request, env, eventId)
    }
    const retryMatch = /^\/admin\/events\/([^/]+)\/deliveries\/([^/]+)\/retry$/.exec(url.pathname)
    if (retryMatch) {
      let eventId: string
      let sinkName: string
      try {
        eventId = decodeURIComponent(retryMatch[1]!)
        sinkName = decodeURIComponent(retryMatch[2]!)
      } catch {
        return new Response('not found', { status: 404 })
      }
      return handleAdminRetry(request, env, eventId, sinkName)
    }
    return new Response('not found', { status: 404 })
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env)
  },

  async email(message: IncomingEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, env, ctx)
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await enqueuePendingDeliveries(env)
    if (result.queued > 0 || result.deferred > 0) {
      console.log(JSON.stringify({
        level: result.deferred > 0 ? 'warn' : 'info',
        msg: 'delivery.outbox.swept',
        queued: result.queued,
        deferred: result.deferred,
      }))
    }
  },
} satisfies ExportedHandler<Env>
