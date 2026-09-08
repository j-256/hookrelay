import { z } from 'zod'
import type { Env } from '../index'
import { CONFIGURATION_MODE, authorityIdSchema, configurationQuery, readConfigurationState, type ConfigurationEntry } from '../configuration/authority'
import { OPERATIONAL_SIGNAL_CODES } from '../operations'
import { DELIVERY_DECISION_REASONS, SEVERITIES } from '../types'
import {
  DELIVERY_STATES, MANAGEMENT_LIMITS, managementInputs,
  ManagementError, managementId, managementName,
} from './contract'

const timestamp = z.iso.datetime()
const deliverySchema = z.object({
  eventId: managementId,
  sinkName: managementName,
  generation: z.number().int().nonnegative(),
  status: z.enum(DELIVERY_STATES),
  attempts: z.number().int().nonnegative(),
  decisionReason: z.enum(DELIVERY_DECISION_REASONS).nullable(),
  updatedAt: timestamp,
  deliveredAt: timestamp.nullable(),
  receivedAt: timestamp,
  subscription: managementName,
  source: managementName,
})
export type ManagementDelivery = z.infer<typeof deliverySchema>

function metadata<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ManagementError('metadata_invalid', 502, 'Provider metadata could not be read safely')
  }
  return parsed.data
}

const deliveryColumns = `d.event_id AS eventId, d.sink_name AS sinkName,
  d.generation, d.status, d.attempts, d.decision_reason AS decisionReason,
  d.updated_at AS updatedAt, d.delivered_at AS deliveredAt,
  e.received_at AS receivedAt, e.sub_name AS subscription, e.source`

export async function readDelivery(env: Env, eventId: string, sinkName: string): Promise<ManagementDelivery> {
  const row = await env.EVENTS_DB.prepare(
    `SELECT ${deliveryColumns} FROM deliveries d JOIN events e ON e.id = d.event_id
     WHERE d.event_id = ? AND d.sink_name = ?`,
  ).bind(eventId, sinkName).first()
  if (!row) throw new ManagementError('not_found', 404, 'Delivery not found')
  return metadata(deliverySchema, row)
}

export async function readDeliveries(env: Env, input: z.infer<typeof managementInputs.deliveries>) {
  const clauses: string[] = []
  const bindings: (string | number)[] = []
  if (input.status) { clauses.push('d.status = ?'); bindings.push(input.status) }
  if (input.cursor) {
    clauses.push('(d.updated_at, d.event_id, d.sink_name) < (?, ?, ?)')
    bindings.push(input.cursor.updatedAt, input.cursor.eventId, input.cursor.sinkName)
  }
  const result = await env.EVENTS_DB.prepare(
    `SELECT ${deliveryColumns} FROM deliveries d JOIN events e ON e.id = d.event_id
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY d.updated_at DESC, d.event_id DESC, d.sink_name DESC LIMIT ?`,
  ).bind(...bindings, MANAGEMENT_LIMITS.PAGE_SIZE + 1).all()
  const rows = metadata(z.array(deliverySchema), result.results)
  const candidates = rows.slice(0, MANAGEMENT_LIMITS.PAGE_SIZE)
  const last = candidates.at(-1)
  return {
    items: candidates.filter(row => !input.subscription || row.subscription === input.subscription),
    nextCursor: rows.length > MANAGEMENT_LIMITS.PAGE_SIZE && last
      ? { updatedAt: last.updatedAt, eventId: last.eventId, sinkName: last.sinkName }
      : null,
    scanned: candidates.length,
    observedAt: new Date().toISOString(),
    pagination: 'live-updated-desc' as const,
  }
}

const subscriptionSchema = z.object({
  name: managementName, source: managementName, enabled: z.boolean(),
  sinks: z.array(managementName).max(100),
})

export async function readSubscriptions(env: Env, cursor: string | null) {
  const query = configurationQuery(env.EVENTS_DB)
  const state = await readConfigurationState(query)
  if (state.mode === CONFIGURATION_MODE.ACTIVE) {
    const cursorPrefix = 'configuration:'
    const parts = cursor?.startsWith(cursorPrefix) ? cursor.slice(cursorPrefix.length).split(':') : []
    const [authorityId, revision, last] = parts
    if (cursor && (parts.length !== 3 || !authorityIdSchema.safeParse(authorityId).success ||
        authorityId !== state.authorityId || revision !== String(state.revision) || !z.uuid().safeParse(last).success)) {
      throw new ManagementError('cursor_invalid', 409, 'Subscription inventory changed; restart pagination')
    }
    const rows = await query<ConfigurationEntry>({
      sql: `SELECT resource_id AS resourceId, value FROM configuration_entries
        WHERE namespace = 'SUBS' AND entry_key LIKE 'sub:sha256:%' AND resource_id > ? ORDER BY resource_id LIMIT ?`,
      params: [last ?? '', MANAGEMENT_LIMITS.PAGE_SIZE + 1],
    })
    const observed = await readConfigurationState(query)
    if (observed.authorityId !== state.authorityId || observed.revision !== state.revision || observed.mode !== state.mode) {
      throw new ManagementError('cursor_invalid', 409, 'Subscription inventory changed; restart pagination')
    }
    const candidates = rows.slice(0, MANAGEMENT_LIMITS.PAGE_SIZE)
    return {
      items: candidates.map(entry => {
        try { return metadata(subscriptionSchema, JSON.parse(entry.value)) } catch {
          throw new ManagementError('metadata_invalid', 502, 'Subscription metadata could not be read safely')
        }
      }),
      nextCursor: rows.length > MANAGEMENT_LIMITS.PAGE_SIZE ? `${cursorPrefix}${state.authorityId}:${state.revision}:${candidates.at(-1)!.resourceId}` : null,
      disappeared: 0, observedAt: new Date().toISOString(),
    }
  }
  const page = await env.SUBS.list({
    prefix: 'sub:sha256:', limit: MANAGEMENT_LIMITS.PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  })
  const items: z.infer<typeof subscriptionSchema>[] = []
  let disappeared = 0
  for (const key of page.keys) {
    const raw = await env.SUBS.get(key.name)
    if (raw === null) { disappeared += 1; continue }
    if (raw.length > MANAGEMENT_LIMITS.SUBSCRIPTION_BYTES ||
        new TextEncoder().encode(raw).byteLength > MANAGEMENT_LIMITS.SUBSCRIPTION_BYTES) {
      throw new ManagementError('metadata_invalid', 502, 'Subscription metadata exceeds the read limit')
    }
    let value: unknown
    try { value = JSON.parse(raw) } catch {
      throw new ManagementError('metadata_invalid', 502, 'Subscription metadata could not be read safely')
    }
    items.push(metadata(subscriptionSchema, value))
  }
  return {
    items,
    nextCursor: page.list_complete ? null : page.cursor,
    disappeared,
    observedAt: new Date().toISOString(),
  }
}

const signalSchema = z.object({
  code: z.enum(OPERATIONAL_SIGNAL_CODES), severity: z.enum(SEVERITIES),
  firstSeenAt: timestamp, lastSeenAt: timestamp,
  occurrences: z.number().int().positive(), resolvedAt: timestamp.nullable(),
})

export async function readSnapshot(env: Env) {
  const [sample, signals, retention] = await Promise.all([
    env.EVENTS_DB.prepare(
      `SELECT status FROM deliveries
       ORDER BY updated_at DESC, event_id DESC, sink_name DESC LIMIT ?`,
    ).bind(MANAGEMENT_LIMITS.HEALTH_SAMPLE + 1).all<{ status: string }>(),
    env.EVENTS_DB.prepare(
      `SELECT code, severity, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
              occurrences, resolved_at AS resolvedAt
       FROM operational_signals ORDER BY last_seen_at DESC LIMIT ?`,
    ).bind(MANAGEMENT_LIMITS.PAGE_SIZE + 1).all(),
    env.EVENTS_DB.prepare(
      "SELECT updated_at FROM maintenance_state WHERE key = 'retention:last-success'",
    ).first<{ updated_at: string }>(),
  ])
  const rows = metadata(z.array(z.object({ status: z.enum(DELIVERY_STATES) })), sample.results)
  const totals = Object.fromEntries(DELIVERY_STATES.map(state => [state, 0])) as Record<typeof DELIVERY_STATES[number], number>
  for (const row of rows.slice(0, MANAGEMENT_LIMITS.HEALTH_SAMPLE)) totals[row.status] += 1
  const signalRows = metadata(z.array(signalSchema), signals.results)
  return {
    observedAt: new Date().toISOString(),
    deliveries: {
      totals, sampled: Math.min(rows.length, MANAGEMENT_LIMITS.HEALTH_SAMPLE),
      limit: MANAGEMENT_LIMITS.HEALTH_SAMPLE, truncated: rows.length > MANAGEMENT_LIMITS.HEALTH_SAMPLE,
    },
    signals: {
      items: signalRows.slice(0, MANAGEMENT_LIMITS.PAGE_SIZE),
      truncated: signalRows.length > MANAGEMENT_LIMITS.PAGE_SIZE,
    },
    lastRetentionAt: retention ? metadata(timestamp, retention.updated_at) : null,
  }
}
