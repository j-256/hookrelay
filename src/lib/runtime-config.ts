export const OPERATIONS_CONFIG_KEY = 'config:operations'
export const RETENTION_CONFIG_KEY = 'config:retention'
export const OPERATIONS_FALLBACK_PREFIX = 'ops-fallback:'

export interface OperationsConfig {
  sinks: string[]
  alertCooldownMinutes: number
  staleDeliveryMinutes: number
}

export interface RetentionConfig {
  r2Days?: number
  d1Days?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function parseOperationsConfig(value: string | null): OperationsConfig | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return null
    if (!Array.isArray(parsed.sinks) || parsed.sinks.length === 0) return null
    if (!parsed.sinks.every((sink) => typeof sink === 'string' && sink.length > 0)) return null
    if (new Set(parsed.sinks).size !== parsed.sinks.length) return null
    if (!positiveInteger(parsed.alertCooldownMinutes)) return null
    if (!positiveInteger(parsed.staleDeliveryMinutes)) return null
    return {
      sinks: parsed.sinks,
      alertCooldownMinutes: parsed.alertCooldownMinutes,
      staleDeliveryMinutes: parsed.staleDeliveryMinutes,
    }
  } catch {
    return null
  }
}

export function parseRetentionConfig(value: string | null): RetentionConfig | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) return null
    const r2Days = parsed.r2Days
    const d1Days = parsed.d1Days
    if (r2Days !== undefined && !positiveInteger(r2Days)) return null
    if (d1Days !== undefined && !positiveInteger(d1Days)) return null
    if (r2Days === undefined && d1Days === undefined) return null
    return {
      ...(r2Days !== undefined ? { r2Days } : {}),
      ...(d1Days !== undefined ? { d1Days } : {}),
    }
  } catch {
    return null
  }
}
