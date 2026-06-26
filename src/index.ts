import './registry'
import { handleAdminEvents, handleAdminRaw } from './admin/events'
import { handleHook } from './router'

export interface Env {
  SUBS: KVNamespace
  SINKS: KVNamespace
  EVENTS_DB: D1Database
  EVENTS_RAW: R2Bucket
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
    if (url.pathname === '/admin/events') {
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
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
