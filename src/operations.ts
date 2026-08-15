import { dispatchSink } from './fanout'
import type { Env } from './index'
import { sha256Hex } from './lib/hmac'
import {
  OPERATIONS_CONFIG_KEY,
  OPERATIONS_FALLBACK_PREFIX,
  parseOperationsConfig,
  type OperationsConfig,
} from './lib/runtime-config'
import type { NormalizedEvent, Severity } from './types'

export const OPERATIONAL_SIGNAL_CODES = [
  'ingress-payload-too-large',
  'ingress-adapter-missing',
  'ingress-authentication-rejected',
  'ingress-parse-rejected',
  'ingress-persistence-rejected',
  'delivery-exhausted',
  'delivery-stale',
  'retention-prune-rejected',
] as const

export type OperationalSignalCode = (typeof OPERATIONAL_SIGNAL_CODES)[number]

interface SignalDefinition {
  severity: Severity
  summary: string
}

const SIGNAL_DEFINITIONS: Record<OperationalSignalCode, SignalDefinition> = {
  'ingress-payload-too-large': {
    severity: 'warning',
    summary: 'A known route rejected an oversized payload',
  },
  'ingress-adapter-missing': {
    severity: 'critical',
    summary: 'A known route has no registered source adapter',
  },
  'ingress-authentication-rejected': {
    severity: 'warning',
    summary: 'A known route rejected webhook authentication',
  },
  'ingress-parse-rejected': {
    severity: 'error',
    summary: 'A known route rejected an authenticated payload',
  },
  'ingress-persistence-rejected': {
    severity: 'critical',
    summary: 'An authenticated event could not be persisted',
  },
  'delivery-exhausted': {
    severity: 'error',
    summary: 'A sink delivery exhausted automatic retries',
  },
  'delivery-stale': {
    severity: 'warning',
    summary: 'A sink delivery remained active beyond its threshold',
  },
  'retention-prune-rejected': {
    severity: 'error',
    summary: 'The scheduled event-retention pass failed',
  },
}

const FALLBACK_EXPIRATION_SECONDS = 7 * 24 * 60 * 60
const FALLBACK_IMPORT_LIMIT = 100
const STALE_SCAN_LIMIT = 100
const ALERT_SCAN_LIMIT = 100
const ALERT_RETRY_MINUTES = 5

export interface OperationalSignalInput {
  code: OperationalSignalCode
  source?: string
  subName?: string
  eventId?: string
  sinkName?: string
}

interface FallbackSignal extends OperationalSignalInput {
  version: 1
  observedAt: string
}

interface OperationalSignalRow {
  fingerprint: string
  code: OperationalSignalCode
  severity: Severity
  source: string | null
  sub_name: string | null
  event_id: string | null
  sink_name: string | null
  summary: string
  occurrences: number
}

interface DeliveryIdentityRow {
  source: string
  sub_name: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function isSignalCode(value: unknown): value is OperationalSignalCode {
  return typeof value === 'string' && OPERATIONAL_SIGNAL_CODES.includes(value as OperationalSignalCode)
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 ? value : undefined
}

function parseFallback(value: string | null): FallbackSignal | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (parsed.version !== 1 || !isSignalCode(parsed.code)) return null
    if (typeof parsed.observedAt !== 'string' || Number.isNaN(Date.parse(parsed.observedAt))) return null
    return {
      version: 1,
      code: parsed.code,
      observedAt: parsed.observedAt,
      ...(optionalText(parsed.source) ? { source: optionalText(parsed.source) } : {}),
      ...(optionalText(parsed.subName) ? { subName: optionalText(parsed.subName) } : {}),
      ...(optionalText(parsed.eventId) ? { eventId: optionalText(parsed.eventId) } : {}),
      ...(optionalText(parsed.sinkName) ? { sinkName: optionalText(parsed.sinkName) } : {}),
    }
  } catch {
    return null
  }
}

export async function operationalSignalFingerprint(input: OperationalSignalInput): Promise<string> {
  const identity = JSON.stringify([
    input.code,
    input.source ?? null,
    input.subName ?? null,
    input.eventId ?? null,
    input.sinkName ?? null,
  ])
  return sha256Hex(new TextEncoder().encode(identity))
}

async function upsertSignal(
  env: Env,
  input: OperationalSignalInput,
  observedAt: string,
): Promise<string> {
  const definition = SIGNAL_DEFINITIONS[input.code]
  const fingerprint = await operationalSignalFingerprint(input)
  await env.EVENTS_DB.prepare(
    `INSERT INTO operational_signals
     (fingerprint, code, severity, source, sub_name, event_id, sink_name, summary,
      first_seen_at, last_seen_at, occurrences, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(fingerprint) DO UPDATE SET
       severity = excluded.severity,
       summary = excluded.summary,
       last_seen_at = excluded.last_seen_at,
       occurrences = operational_signals.occurrences + 1,
       resolved_at = NULL`,
  )
    .bind(
      fingerprint,
      input.code,
      definition.severity,
      input.source ?? null,
      input.subName ?? null,
      input.eventId ?? null,
      input.sinkName ?? null,
      definition.summary,
      observedAt,
      observedAt,
    )
    .run()
  return fingerprint
}

async function writeFallback(env: Env, input: OperationalSignalInput, observedAt: string): Promise<void> {
  try {
    const fingerprint = await operationalSignalFingerprint(input)
    const record: FallbackSignal = { version: 1, ...input, observedAt }
    await env.SUBS.put(
      `${OPERATIONS_FALLBACK_PREFIX}${fingerprint}:${crypto.randomUUID()}`,
      JSON.stringify(record),
      { expirationTtl: FALLBACK_EXPIRATION_SECONDS },
    )
  } catch {
    console.log(JSON.stringify({ level: 'error', msg: 'operations.signal.unavailable' }))
  }
}

export async function recordOperationalSignal(
  env: Env,
  input: OperationalSignalInput,
): Promise<void> {
  const observedAt = nowIso()
  try {
    await upsertSignal(env, input, observedAt)
  } catch {
    await writeFallback(env, input, observedAt)
  }
}

export async function resolveOperationalSignal(
  env: Env,
  input: OperationalSignalInput,
): Promise<void> {
  try {
    const fingerprint = await operationalSignalFingerprint(input)
    await env.EVENTS_DB.prepare(
      'UPDATE operational_signals SET resolved_at = ? WHERE fingerprint = ? AND resolved_at IS NULL',
    )
      .bind(nowIso(), fingerprint)
      .run()
  } catch {
    console.log(JSON.stringify({ level: 'warn', msg: 'operations.signal.resolve_failed' }))
  }
}

export async function importOperationalFallbacks(env: Env): Promise<number> {
  let imported = 0
  let listed: KVNamespaceListResult<unknown>
  try {
    listed = await env.SUBS.list({ prefix: OPERATIONS_FALLBACK_PREFIX, limit: FALLBACK_IMPORT_LIMIT })
  } catch {
    return imported
  }
  for (const key of listed.keys) {
    try {
      const fallback = parseFallback(await env.SUBS.get(key.name))
      if (!fallback) continue
      const { version: _version, observedAt, ...input } = fallback
      await upsertSignal(env, input, observedAt)
      await env.SUBS.delete(key.name)
      imported += 1
    } catch {
      break
    }
  }
  return imported
}

export async function loadOperationsConfig(env: Env): Promise<OperationsConfig | null> {
  try {
    return parseOperationsConfig(await env.SUBS.get(OPERATIONS_CONFIG_KEY))
  } catch {
    return null
  }
}

async function deliveryIdentity(
  env: Env,
  eventId: string,
): Promise<DeliveryIdentityRow | null> {
  return env.EVENTS_DB.prepare('SELECT source, sub_name FROM events WHERE id = ?')
    .bind(eventId)
    .first<DeliveryIdentityRow>()
}

export async function recordDeliverySignal(
  env: Env,
  code: 'delivery-exhausted' | 'delivery-stale',
  eventId: string,
  sinkName: string,
): Promise<void> {
  try {
    const identity = await deliveryIdentity(env, eventId)
    if (!identity) return
    await recordOperationalSignal(env, {
      code,
      source: identity.source,
      subName: identity.sub_name,
      eventId,
      sinkName,
    })
  } catch {
    await recordOperationalSignal(env, { code, eventId, sinkName })
  }
}

export async function resolveDeliverySignals(
  env: Env,
  eventId: string,
  sinkName: string,
): Promise<void> {
  try {
    await env.EVENTS_DB.prepare(
      `UPDATE operational_signals SET resolved_at = ?
       WHERE code IN ('delivery-exhausted', 'delivery-stale')
         AND event_id = ? AND sink_name = ? AND resolved_at IS NULL`,
    )
      .bind(nowIso(), eventId, sinkName)
      .run()
  } catch {
    console.log(JSON.stringify({ level: 'warn', msg: 'operations.delivery.resolve_failed' }))
  }
}

export async function recordStaleDeliveries(
  env: Env,
  config: OperationsConfig,
): Promise<number> {
  const cutoff = new Date(Date.now() - config.staleDeliveryMinutes * 60 * 1000).toISOString()
  const rows = await env.EVENTS_DB.prepare(
    `SELECT deliveries.event_id, deliveries.sink_name, events.source, events.sub_name
     FROM deliveries JOIN events ON events.id = deliveries.event_id
     WHERE deliveries.status IN ('pending', 'queued', 'processing', 'retrying')
       AND deliveries.updated_at <= ?
     ORDER BY deliveries.updated_at ASC LIMIT ?`,
  )
    .bind(cutoff, STALE_SCAN_LIMIT)
    .all<{ event_id: string; sink_name: string; source: string; sub_name: string }>()
  for (const row of rows.results ?? []) {
    await recordOperationalSignal(env, {
      code: 'delivery-stale',
      source: row.source,
      subName: row.sub_name,
      eventId: row.event_id,
      sinkName: row.sink_name,
    })
  }
  return rows.results?.length ?? 0
}

function alertEvent(signal: OperationalSignalRow): NormalizedEvent {
  const observedAt = nowIso()
  const details = [
    `Code: ${signal.code}`,
    `Occurrences: ${signal.occurrences}`,
    signal.source ? `Source: ${signal.source}` : null,
    signal.sub_name ? `Subscription: ${signal.sub_name}` : null,
    signal.event_id ? `Event: ${signal.event_id}` : null,
    signal.sink_name ? `Sink: ${signal.sink_name}` : null,
  ].filter((value): value is string => value !== null)
  return {
    source: 'hookrelay',
    subName: 'operations',
    type: `hookrelay.operations.${signal.code}`,
    id: signal.fingerprint,
    timestamp: observedAt,
    title: signal.summary,
    body: details.join('\n'),
    severity: signal.severity,
    raw: {
      code: signal.code,
      occurrences: signal.occurrences,
      source: signal.source,
      subscription: signal.sub_name,
      eventId: signal.event_id,
      sinkName: signal.sink_name,
    },
  }
}

export async function dispatchOperationalAlerts(
  env: Env,
  config: OperationsConfig,
): Promise<{ delivered: number; failed: number; skipped: number }> {
  const signals = await env.EVENTS_DB.prepare(
    `SELECT fingerprint, code, severity, source, sub_name, event_id, sink_name, summary, occurrences
     FROM operational_signals WHERE resolved_at IS NULL
     ORDER BY last_seen_at ASC LIMIT ?`,
  )
    .bind(ALERT_SCAN_LIMIT)
    .all<OperationalSignalRow>()
  let delivered = 0
  let failed = 0
  let skipped = 0
  const timestamp = nowIso()
  for (const signal of signals.results ?? []) {
    for (const sinkName of config.sinks) {
      if (signal.sink_name === sinkName) {
        skipped += 1
        continue
      }
      await env.EVENTS_DB.prepare(
        `INSERT OR IGNORE INTO operational_alert_deliveries
         (fingerprint, sink_name) VALUES (?, ?)`,
      ).bind(signal.fingerprint, sinkName).run()
      const state = await env.EVENTS_DB.prepare(
        `SELECT alerted_occurrences, attempts, next_attempt_at
         FROM operational_alert_deliveries WHERE fingerprint = ? AND sink_name = ?`,
      )
        .bind(signal.fingerprint, sinkName)
        .first<{ alerted_occurrences: number; attempts: number; next_attempt_at: string | null }>()
      if (
        !state ||
        state.alerted_occurrences >= signal.occurrences ||
        (state.next_attempt_at !== null && state.next_attempt_at > timestamp)
      ) {
        skipped += 1
        continue
      }
      const result = await dispatchSink(env, alertEvent(signal), sinkName, {
        eventId: `operations:${signal.fingerprint}`,
        sinkName,
        generation: signal.occurrences,
        attempt: state.attempts + 1,
      })
      const retryMinutes = result.ok
        ? config.alertCooldownMinutes
        : Math.min(config.alertCooldownMinutes, ALERT_RETRY_MINUTES)
      const nextAttemptAt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString()
      await env.EVENTS_DB.prepare(
        `UPDATE operational_alert_deliveries SET
           alerted_occurrences = ?, attempts = attempts + 1, last_attempt_at = ?,
           next_attempt_at = ?, last_error = ?, delivered_at = ?
         WHERE fingerprint = ? AND sink_name = ?`,
      )
        .bind(
          result.ok ? signal.occurrences : state.alerted_occurrences,
          timestamp,
          nextAttemptAt,
          result.ok ? null : 'operations alert delivery failed',
          result.ok ? timestamp : null,
          signal.fingerprint,
          sinkName,
        )
        .run()
      if (result.ok) delivered += 1
      else failed += 1
    }
  }
  return { delivered, failed, skipped }
}

export async function runOperationalMaintenance(
  env: Env,
): Promise<{ imported: number; stale: number; delivered: number; failed: number; skipped: number }> {
  const imported = await importOperationalFallbacks(env)
  const config = await loadOperationsConfig(env)
  if (!config) return { imported, stale: 0, delivered: 0, failed: 0, skipped: 0 }
  const stale = await recordStaleDeliveries(env, config)
  const alerts = await dispatchOperationalAlerts(env, config)
  return { imported, stale, ...alerts }
}
