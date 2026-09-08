import { z } from 'zod'
import { OPERATIONS_CONFIG_KEY, RETENTION_CONFIG_KEY } from '../lib/runtime-config'
import { SUBSCRIPTION_KEY_PREFIX } from '../lib/subscription'

export const CONFIGURATION_LIMITS = Object.freeze({
  ENTRIES: 500,
  CHANGE_BYTES: 262144,
  ENTRY_BYTES: 32768,
  PAGE_SIZE: 25,
  REVIEW_TTL_MS: 5 * 60 * 1000,
  PENDING_REVIEWS: 25,
  RECEIPT_DAYS: 30,
  PRUNE_BATCH: 100,
})
export const CONFIGURATION_MODE = Object.freeze({ LEGACY: 'legacy', ACTIVE: 'active' } as const)
const identity = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const authorityIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const namespaceSchema = z.enum(['SUBS', 'SINKS'])
const keySchema = z.string().min(1).max(240)
const subscriptionKeyPattern = new RegExp(`^${SUBSCRIPTION_KEY_PREFIX}[a-f0-9]{64}$`)
const entryKeySchema = z.object({ namespace: namespaceSchema, key: keySchema }).strict()
export const configurationEntrySchema = entryKeySchema.extend({ resourceId: z.uuid(), retired: z.boolean().default(false), value: z.string() }).strict()
export const configurationOwnerSchema = z.object({
  clientId: identity, clientRevision: z.number().int().positive(), workspaceId: identity, actorId: identity,
}).strict()
const authorityStateSchema = z.object({
  authorityId: authorityIdSchema, revision: z.number().int().nonnegative(), mode: z.enum(['legacy', 'active']),
}).strict()
const changeSchema = configurationOwnerSchema.extend({
  operationId: z.uuid(), authorityId: authorityIdSchema, expectedRevision: z.number().int().nonnegative(),
  kind: z.enum(['migration', 'import', 'policy']), resourceId: z.uuid().nullable().default(null),
  expiresAt: z.iso.datetime(),
  puts: z.array(configurationEntrySchema).max(CONFIGURATION_LIMITS.ENTRIES),
  deletes: z.array(entryKeySchema).max(CONFIGURATION_LIMITS.ENTRIES),
}).strict()
export type ConfigurationState = z.infer<typeof authorityStateSchema>
export type ConfigurationEntry = z.input<typeof configurationEntrySchema>
export type ConfigurationOwner = z.infer<typeof configurationOwnerSchema>
export type ConfigurationChange = z.input<typeof changeSchema>
export interface ConfigurationStatement { sql: string; params: (string | number | null)[] }
export type ConfigurationQuery = <Row = Record<string, unknown>>(statement: ConfigurationStatement) => Promise<Row[]>
export interface ConfigurationReceipt {
  id: string
  authorityId: string
  revision: number
  beforeRevision: number
  clientId: string
  clientRevision: number
  workspaceId: string
  actorId: string
  kind: ConfigurationChange['kind']
  resourceId: string | null
  inputHash: string
  acceptedAt: string
}

export class ConfigurationError extends Error {
  constructor(readonly code: 'unavailable' | 'validation' | 'conflict' | 'expired' | 'not_found' | 'inactive', message: string) {
    super(message)
  }
}

export function configurationQuery(database: D1Database): ConfigurationQuery {
  return async <Row>(statement: ConfigurationStatement): Promise<Row[]> => {
    try {
      const result = await database.prepare(statement.sql).bind(...statement.params).all<Row>()
      if (!result.success) throw new Error()
      return result.results
    } catch {
      throw new ConfigurationError('unavailable', 'Configuration is unavailable; reconcile uncertain operations before retrying')
    }
  }
}

export function canonicalConfiguration(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalConfiguration).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalConfiguration((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export async function configurationDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalConfiguration(value)))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function validEntryKey(entry: z.infer<typeof entryKeySchema>): boolean {
  return entry.namespace === 'SUBS'
    ? subscriptionKeyPattern.test(entry.key) ||
      entry.key === OPERATIONS_CONFIG_KEY || entry.key === RETENTION_CONFIG_KEY
    : /^sink:[^\u0000-\u001f\u007f]{1,160}$/.test(entry.key)
}

export function validateConfigurationChange(input: unknown): ConfigurationChange {
  try {
    const change = changeSchema.parse(input)
    if (new TextEncoder().encode(canonicalConfiguration(change)).byteLength > CONFIGURATION_LIMITS.CHANGE_BYTES) throw new Error()
    const keys = new Set<string>()
    const ids = new Set<string>()
    for (const entry of [...change.puts, ...change.deletes]) {
      const key = `${entry.namespace}:${entry.key}`
      if (!validEntryKey(entry) || keys.has(key)) throw new Error()
      keys.add(key)
    }
    for (const entry of change.puts) {
      if (ids.has(entry.resourceId) || new TextEncoder().encode(entry.value).byteLength > CONFIGURATION_LIMITS.ENTRY_BYTES) throw new Error()
      ids.add(entry.resourceId)
      const value: unknown = JSON.parse(entry.value)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    }
    if (change.puts.length + change.deletes.length === 0 && change.kind !== 'migration') throw new Error()
    if (change.kind === 'migration' && (change.expectedRevision !== 0 || change.deletes.length !== 0)) throw new Error()
    if (change.kind === 'policy' && (change.puts.length !== 1 || change.deletes.length !== 0 || change.resourceId !== change.puts[0]!.resourceId)) throw new Error()
    return change
  } catch {
    throw new ConfigurationError('validation', 'The configuration change is invalid or exceeds its supported bounds')
  }
}

export async function readConfigurationState(query: ConfigurationQuery): Promise<ConfigurationState> {
  const rows = await query<ConfigurationState>({
    sql: 'SELECT authority_id AS authorityId, revision, mode FROM configuration_authority WHERE singleton = 1', params: [],
  })
  const parsed = authorityStateSchema.safeParse(rows[0])
  if (!parsed.success) throw new ConfigurationError('unavailable', 'The configuration authority is not initialized')
  return parsed.data
}

export async function readConfigurationEntries(query: ConfigurationQuery): Promise<ConfigurationEntry[]> {
  const rows = await query<ConfigurationEntry>({
    sql: 'SELECT namespace, entry_key AS key, resource_id AS resourceId, retired, value FROM configuration_entries ORDER BY namespace, entry_key LIMIT ?',
    params: [CONFIGURATION_LIMITS.ENTRIES + 1],
  })
  if (rows.length > CONFIGURATION_LIMITS.ENTRIES) throw new ConfigurationError('unavailable', 'Configuration exceeds the supported inventory bound')
  return rows.map(row => ({ ...row, retired: Boolean(row.retired) }))
}

const RECEIPT_SELECT = `SELECT id, authority_id AS authorityId, revision, before_revision AS beforeRevision,
  client_id AS clientId, client_revision AS clientRevision, workspace_id AS workspaceId, actor_id AS actorId,
  kind, resource_id AS resourceId, input_hash AS inputHash, accepted_at AS acceptedAt
  FROM configuration_receipts WHERE id = ?`

function sameOwner(receipt: ConfigurationOwner, owner: ConfigurationOwner): boolean {
  return receipt.clientId === owner.clientId && receipt.clientRevision === owner.clientRevision &&
    receipt.workspaceId === owner.workspaceId && receipt.actorId === owner.actorId
}

export async function readConfigurationReceipt(query: ConfigurationQuery, operationId: string, owner: ConfigurationOwner): Promise<ConfigurationReceipt | null> {
  const [receipt] = await query<ConfigurationReceipt>({ sql: RECEIPT_SELECT, params: [operationId] })
  if (!receipt) return null
  if (!sameOwner(receipt, owner)) throw new ConfigurationError('not_found', 'Configuration operation not found')
  return receipt
}

export async function acceptConfigurationChange(query: ConfigurationQuery, input: ConfigurationChange): Promise<ConfigurationReceipt> {
  const change = validateConfigurationChange(input)
  const inputHash = await configurationDigest(change)
  async function replay(): Promise<ConfigurationReceipt | null> {
    const receipt = await readConfigurationReceipt(query, change.operationId, change)
    if (receipt && receipt.inputHash !== inputHash) throw new ConfigurationError('conflict', 'The operation ID belongs to different reviewed inputs')
    return receipt
  }
  const previous = await replay()
  if (previous) return previous
  if (Date.parse(change.expiresAt) <= Date.now()) throw new ConfigurationError('expired', 'The configuration review expired; review the change again')
  const state = await readConfigurationState(query)
  if (state.authorityId !== change.authorityId || state.revision !== change.expectedRevision) {
    throw new ConfigurationError('conflict', 'Configuration changed; refresh the baseline and review again')
  }
  const expectedMode = change.kind === 'migration' ? CONFIGURATION_MODE.LEGACY : CONFIGURATION_MODE.ACTIVE
  if (state.mode !== expectedMode) throw new ConfigurationError('inactive', 'The configuration authority is not in the required mode')
  const entries = await query<Omit<ConfigurationEntry, 'value'> & { bytes: number }>({
    sql: `SELECT namespace, entry_key AS key, resource_id AS resourceId, length(CAST(value AS BLOB)) AS bytes
      FROM configuration_entries LIMIT ?`, params: [CONFIGURATION_LIMITS.ENTRIES + 1],
  })
  const removedKeys = new Set(change.deletes.map(entry => `${entry.namespace}:${entry.key}`))
  const updatedKeys = new Set(change.puts.map(entry => `${entry.namespace}:${entry.key}`))
  const retained = entries.filter(entry => !removedKeys.has(`${entry.namespace}:${entry.key}`) && !updatedKeys.has(`${entry.namespace}:${entry.key}`))
  const totalBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0) +
    change.puts.reduce((sum, entry) => sum + new TextEncoder().encode(entry.value).byteLength, 0)
  if (retained.length + change.puts.length > CONFIGURATION_LIMITS.ENTRIES || totalBytes > CONFIGURATION_LIMITS.CHANGE_BYTES) {
    throw new ConfigurationError('validation', 'The change exceeds the configuration inventory bound')
  }
  for (const next of change.puts) {
    const old = entries.find(entry => entry.namespace === next.namespace && entry.key === next.key)
    if (old && old.resourceId !== next.resourceId) throw new ConfigurationError('conflict', 'An existing resource identity cannot be replaced')
  }
  const payload = canonicalConfiguration({ ...change, inputHash })
  await query({
    sql: `UPDATE configuration_authority
      SET revision = revision + 1, mode = 'active', operation_id = ?, pending_change = ?
      WHERE singleton = 1 AND authority_id = ? AND revision = ? AND mode = ?
        AND julianday(?) > julianday('now')
      RETURNING revision`,
    params: [change.operationId, payload, change.authorityId, change.expectedRevision, expectedMode, change.expiresAt],
  })
  const accepted = await replay()
  if (accepted) return accepted
  if (Date.parse(change.expiresAt) <= Date.now()) throw new ConfigurationError('expired', 'The configuration review expired; review the change again')
  throw new ConfigurationError('conflict', 'Configuration changed; refresh the baseline and review again')
}

export async function readRuntimeConfiguration(
  env: { EVENTS_DB: D1Database; SUBS: KVNamespace; SINKS: KVNamespace },
  namespace: 'SUBS' | 'SINKS', key: string,
): Promise<string | null> {
  const [row] = await configurationQuery(env.EVENTS_DB)<{ mode: ConfigurationState['mode']; value: string | null }>({
    sql: `SELECT authority.mode, entry.value FROM configuration_authority AS authority
      LEFT JOIN configuration_entries AS entry ON entry.namespace = ? AND entry.entry_key = ?
      WHERE authority.singleton = 1`, params: [namespace, key],
  })
  if (!row) throw new ConfigurationError('unavailable', 'The configuration authority is not initialized')
  if (row.mode === CONFIGURATION_MODE.ACTIVE) return row.value
  if (row.mode === CONFIGURATION_MODE.LEGACY) return env[namespace].get(key)
  throw new ConfigurationError('unavailable', 'The configuration authority mode is invalid')
}

export { digest as configurationDigestSchema }
