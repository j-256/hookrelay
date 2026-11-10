const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function noDestinations(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}

export function requireSafeTelemetryPolicy(value: unknown): void {
  const config = object(value)
  const observability = object(config.observability)
  const logs = object(observability.logs)
  const traces = object(observability.traces)
  const issues = object(observability.issues)
  const tails = config.tail_consumers
  const unsafe = () => { throw new Error('Unsafe telemetry configuration: raw producer storage and exports must be disabled; enabled logs require one sanitizing Tail Worker') }
  if (config.logpush !== undefined && config.logpush !== false) unsafe()
  if (!noDestinations(config.streaming_tail_consumers)) unsafe()
  if (!noDestinations(logs.destinations) || !noDestinations(traces.destinations)) unsafe()
  if (traces.enabled === true || issues.enabled === true) unsafe()
  if (observability.enabled !== true && logs.enabled !== true) {
    if (!noDestinations(tails)) unsafe()
    return
  }
  if (
    logs.persist !== false || traces.enabled !== false || issues.enabled !== false ||
    !Array.isArray(tails) || tails.length !== 1
  ) unsafe()
  const consumer = object((tails as unknown[])[0])
  if (
    typeof consumer.service !== 'string' || !SERVICE_NAME.test(consumer.service) || consumer.service === config.name ||
    Object.keys(consumer).some(key => key !== 'service')
  ) unsafe()
}
