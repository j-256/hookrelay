export const TELEMETRY_LIMITS = Object.freeze({
  BATCH_EVENTS: 100,
  LOG_ENTRIES: 100,
  URL_CHARACTERS: 4096,
  COUNTER: 1_000_000,
  TIMESTAMP_MS: 8_640_000_000_000_000,
})

const OUTCOMES = ['ok', 'canceled', 'exception', 'exceededCpu', 'exceededMemory'] as const
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MANAGEMENT_PATH = '/admin/api/v1'
const KEY_VERIFICATION_PATH = '/management/github-app-key-verification'
type Handler = 'fetch' | 'queue' | 'scheduled' | 'email' | 'alarm' | 'rpc' | 'tail' | 'unknown'
type Route = 'hook' | 'admin' | 'management' | 'github_app_key_verification' | 'other'
type RecordValue = Record<string, unknown>

function record(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
}

function count(value: unknown): number | null {
  return Array.isArray(value) ? Math.min(value.length, TELEMETRY_LIMITS.COUNTER) : null
}

function routeCategory(value: unknown): Route {
  if (typeof value !== 'string' || value.length > TELEMETRY_LIMITS.URL_CHARACTERS) return 'other'
  try {
    const path = new URL(value).pathname
    if (path.startsWith('/hook/')) return 'hook'
    if (path === MANAGEMENT_PATH) return 'management'
    if (path === KEY_VERIFICATION_PATH) return 'github_app_key_verification'
    if (path === '/admin' || path.startsWith('/admin/')) return 'admin'
  } catch {
    // Invalid URLs never become diagnostic text
  }
  return 'other'
}

function handlerCategory(event: RecordValue | null): Handler {
  if (!event) return 'unknown'
  if (record(event.request)) return 'fetch'
  if ('queue' in event) return 'queue'
  if ('cron' in event) return 'scheduled'
  if ('mailFrom' in event || 'rcptTo' in event) return 'email'
  if ('scheduledTime' in event) return 'alarm'
  if ('rpcMethod' in event) return 'rpc'
  if ('consumedEvents' in event) return 'tail'
  return 'unknown'
}

export function sanitizeTailEvent(input: unknown) {
  try {
    const trace = record(input)
    if (!trace || !('event' in trace)) return null
    const event = record(trace.event)
    const handler = handlerCategory(event)
    const request = handler === 'fetch' ? record(event?.request) : null
    const response = handler === 'fetch' ? record(event?.response) : null
    const logs = Array.isArray(trace.logs) ? trace.logs : null
    let warningCount = logs ? 0 : null
    let errorCount = logs ? 0 : null
    if (logs) {
      for (let index = 0; index < Math.min(logs.length, TELEMETRY_LIMITS.LOG_ENTRIES); index++) {
        const level = record(logs[index])?.level
        if (level === 'warn') warningCount!++
        if (level === 'error') errorCount!++
      }
    }
    const version = record(trace.scriptVersion)?.id
    const status = finite(response?.status, 599)
    return {
      schemaVersion: 1,
      event: 'hookrelay.invocation',
      handler,
      route: request ? routeCategory(request.url) : null,
      method: request ? METHODS.find(method => method === request.method) ?? 'OTHER' : null,
      outcome: OUTCOMES.find(outcome => outcome === trace.outcome) ?? 'unknown',
      status: status !== null && Number.isInteger(status) && status >= 100 ? status : null,
      eventTimestampMs: finite(trace.eventTimestamp, TELEMETRY_LIMITS.TIMESTAMP_MS),
      versionId: typeof version === 'string' && VERSION_ID.test(version) ? version : null,
      cpuTimeMs: finite(trace.cpuTime),
      wallTimeMs: finite(trace.wallTime),
      logCount: count(logs),
      warningCount,
      errorCount,
      exceptionCount: count(trace.exceptions),
      truncated: trace.truncated === true,
      logScanLimited: logs !== null && logs.length > TELEMETRY_LIMITS.LOG_ENTRIES,
    }
  } catch {
    return null
  }
}

function emit(value: object): void {
  try {
    console.log(JSON.stringify(value))
  } catch {
    // Failed telemetry cannot expose the input or change the producer outcome
  }
}

export default {
  async tail(events: unknown): Promise<void> {
    const batch = Array.isArray(events) ? events : []
    const processed = Math.min(batch.length, TELEMETRY_LIMITS.BATCH_EVENTS)
    let malformed = Array.isArray(events) ? 0 : 1
    for (let index = 0; index < processed; index++) {
      let summary = null
      try { summary = sanitizeTailEvent(batch[index]) } catch { /* Retain only a fixed malformed counter */ }
      if (summary) emit(summary)
      else malformed++
    }
    const dropped = Math.min(batch.length - processed, TELEMETRY_LIMITS.COUNTER)
    if (malformed || dropped) emit({ schemaVersion: 1, event: 'hookrelay.telemetry.coverage', processed, malformed, dropped })
  },
} satisfies ExportedHandler
