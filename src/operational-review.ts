import { z } from 'zod'
import { ConfigurationError, type ConfigurationOwner, type ConfigurationQuery } from './configuration/authority'
import { OPERATIONAL_SIGNAL_CODES } from './operations'

export const RESOLUTION_LIMITS = Object.freeze({ TARGETS: 25, PAGE_SIZE: 25, PENDING: 25, BYTES: 12 * 1024, TTL_MS: 5 * 60 * 1000 })
const identity = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)
const name = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
export const resolutionReason = z.enum(['recovered', 'obsolete', 'accepted-loss'])
export const signalCursor = z.object({ lastSeenAt: z.iso.datetime(), fingerprint }).strict()
export const signalPageInput = z.object({
  cursor: signalCursor.nullable().default(null),
  resolved: z.boolean().nullable().default(false),
}).strict()
export const resolutionTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('signal'), fingerprint, lastSeenAt: z.iso.datetime(), occurrences: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('delivery'), eventId: identity, sinkName: name, generation: z.number().int().nonnegative(), updatedAt: z.iso.datetime() }).strict(),
])
export const resolutionInput = z.object({
  planId: z.uuid(),
  targets: z.array(resolutionTarget).min(1).max(RESOLUTION_LIMITS.TARGETS)
    .refine(targets => new Set(targets.map(target => target.kind === 'signal'
      ? `signal:${target.fingerprint}` : JSON.stringify(['delivery', target.eventId, target.sinkName]))).size === targets.length),
  reason: resolutionReason,
  note: z.string().trim().min(1).max(500).regex(/^[\x20-\x7e]+$/),
}).strict()
export type ResolutionInput = z.infer<typeof resolutionInput>
const signalSchema = z.object({
  fingerprint, code: z.enum(OPERATIONAL_SIGNAL_CODES),
  severity: z.enum(['debug', 'info', 'warning', 'error', 'critical']),
  source: name.nullable(), subscription: name.nullable(), eventId: identity.nullable(), sinkName: name.nullable(),
  firstSeenAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(), occurrences: z.number().int().positive(),
  resolvedAt: z.iso.datetime().nullable(), resolutionReason: resolutionReason.nullable(),
})
interface ReviewRow {
  id: string; targets_json: string; reason: z.infer<typeof resolutionReason>; note: string
  created_at: string; expires_at: string; applied_at: string | null
}
const ownerWhere = 'client_id = ? AND client_revision = ? AND workspace_id = ? AND actor_id = ?'
const ownerValues = (owner: ConfigurationOwner) => [owner.clientId, owner.clientRevision, owner.workspaceId, owner.actorId]
const targetsMatch = `NOT EXISTS (
  SELECT 1 FROM json_each(?) t WHERE NOT (
    (json_extract(t.value, '$.kind') = 'signal' AND EXISTS (
      SELECT 1 FROM operational_signals s WHERE s.fingerprint = json_extract(t.value, '$.fingerprint')
      AND s.last_seen_at = json_extract(t.value, '$.lastSeenAt') AND s.occurrences = json_extract(t.value, '$.occurrences')
      AND s.resolved_at IS NULL
    )) OR
    (json_extract(t.value, '$.kind') = 'delivery' AND EXISTS (
      SELECT 1 FROM deliveries d WHERE d.event_id = json_extract(t.value, '$.eventId')
      AND d.sink_name = json_extract(t.value, '$.sinkName') AND d.generation = json_extract(t.value, '$.generation')
      AND d.updated_at = json_extract(t.value, '$.updatedAt') AND d.status = 'exhausted' AND d.resolved_at IS NULL
    ))
  )
)`

function receipt(row: ReviewRow) {
  return {
    ...resolutionInput.parse({ planId: row.id, targets: JSON.parse(row.targets_json), reason: row.reason, note: row.note }),
    createdAt: row.created_at, expiresAt: row.expires_at, acceptedAt: row.applied_at,
    state: row.applied_at ? 'accepted' as const : Date.parse(row.expires_at) <= Date.now() ? 'expired' as const : 'review' as const,
  }
}

async function findReview(query: ConfigurationQuery, owner: ConfigurationOwner, planId: string) {
  const rows = await query<ReviewRow>({
    sql: `SELECT id, targets_json, reason, note, created_at, expires_at, applied_at
      FROM operational_resolution_reviews WHERE id = ? AND ${ownerWhere}`,
    params: [planId, ...ownerValues(owner)],
  })
  return rows[0] ?? null
}

export async function readOperationalSignals(query: ConfigurationQuery, input: unknown) {
  const { cursor, resolved } = signalPageInput.parse(input)
  const clauses: string[] = []
  const params: (string | number | null)[] = []
  if (resolved !== null) clauses.push(`resolved_at IS ${resolved ? 'NOT ' : ''}NULL`)
  if (cursor) {
    clauses.push('(last_seen_at, fingerprint) < (?, ?)')
    params.push(cursor.lastSeenAt, cursor.fingerprint)
  }
  const rows = await query({
    sql: `SELECT fingerprint, code, severity, source, sub_name AS subscription, event_id AS eventId, sink_name AS sinkName,
      first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, occurrences, resolved_at AS resolvedAt,
      resolution_reason AS resolutionReason FROM operational_signals ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY last_seen_at DESC, fingerprint DESC LIMIT ?`,
    params: [...params, RESOLUTION_LIMITS.PAGE_SIZE + 1],
  })
  const parsed = z.array(signalSchema).safeParse(rows)
  if (!parsed.success) throw new ConfigurationError('unavailable', 'Operational metadata could not be read safely')
  const items = parsed.data.slice(0, RESOLUTION_LIMITS.PAGE_SIZE)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > items.length && last ? { lastSeenAt: last.lastSeenAt, fingerprint: last.fingerprint } : null, observedAt: new Date().toISOString() }
}

export async function readOperationalResolution(query: ConfigurationQuery, owner: ConfigurationOwner, planId: string) {
  z.uuid().parse(planId)
  const row = await findReview(query, owner, planId)
  if (!row) throw new ConfigurationError('not_found', 'Operational review not found for this identity')
  return receipt(row)
}

export async function planOperationalResolution(query: ConfigurationQuery, owner: ConfigurationOwner, input: unknown) {
  const fields = resolutionInput.parse(input)
  if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > RESOLUTION_LIMITS.BYTES) {
    throw new ConfigurationError('validation', 'The operational review exceeds its byte limit')
  }
  const targets = JSON.stringify(fields.targets)
  const timestamp = new Date().toISOString()
  const expiresAt = new Date(Date.now() + RESOLUTION_LIMITS.TTL_MS).toISOString()
  await query({
    sql: `INSERT OR IGNORE INTO operational_resolution_reviews
      (id, client_id, client_revision, workspace_id, actor_id, targets_json, reason, note, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${targetsMatch}
      AND (SELECT count(*) FROM (SELECT id FROM operational_resolution_reviews WHERE ${ownerWhere}
        AND applied_at IS NULL AND expires_at > ? LIMIT ?)) < ?`,
    params: [fields.planId, ...ownerValues(owner), targets, fields.reason, fields.note, timestamp, expiresAt,
      targets, ...ownerValues(owner), timestamp, RESOLUTION_LIMITS.PENDING, RESOLUTION_LIMITS.PENDING],
  })
  const row = await findReview(query, owner, fields.planId)
  if (!row || row.targets_json !== targets || row.reason !== fields.reason || row.note !== fields.note) {
    throw new ConfigurationError('conflict', 'The operational state, review identity, or pending review limit changed; inspect before reviewing again')
  }
  return receipt(row)
}

export async function applyOperationalResolution(query: ConfigurationQuery, owner: ConfigurationOwner, planId: string) {
  z.uuid().parse(planId)
  const row = await findReview(query, owner, planId)
  if (!row) throw new ConfigurationError('not_found', 'Operational review not found for this identity')
  if (row.applied_at) return receipt(row)
  if (Date.parse(row.expires_at) <= Date.now()) throw new ConfigurationError('expired', 'The operational review expired; inspect before reviewing again')
  await query({
    sql: `UPDATE operational_resolution_reviews SET applied_at = ? WHERE id = ? AND ${ownerWhere}
      AND applied_at IS NULL AND julianday(expires_at) > julianday('now') AND ${targetsMatch}`,
    params: [new Date().toISOString(), planId, ...ownerValues(owner), row.targets_json],
  })
  const accepted = await readOperationalResolution(query, owner, planId)
  if (accepted.state !== 'accepted') throw new ConfigurationError('conflict', 'Operational state changed; a new review is required')
  return accepted
}
