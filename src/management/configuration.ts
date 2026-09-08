import { z } from 'zod'
import type { Env } from '../index'
import {
  CONFIGURATION_LIMITS, CONFIGURATION_MODE, ConfigurationError, acceptConfigurationChange,
  canonicalConfiguration, configurationDigest, configurationQuery, readConfigurationReceipt,
  readConfigurationState, type ConfigurationEntry, type ConfigurationOwner, type ConfigurationQuery,
} from '../configuration/authority'
import { applySubscriptionPolicy, policyName, readSubscriptionPolicy, subscriptionPolicySchema } from '../configuration/policy'
import { authorizeConfiguration, authorizeManagement, type ManagementPrincipal } from './access'
import { ManagementError, managementInputs, type ManagementContext } from './contract'

function owner(principal: ManagementPrincipal, context: ManagementContext): ConfigurationOwner {
  return { clientId: principal.id, clientRevision: principal.revision, workspaceId: context.workspaceId, actorId: context.actorId }
}

async function activeState(query: ConfigurationQuery) {
  const state = await readConfigurationState(query)
  if (state.mode !== CONFIGURATION_MODE.ACTIVE) {
    throw new ConfigurationError('inactive', 'Online configuration is unavailable until the provider authority is activated')
  }
  return state
}

async function subscription(query: ConfigurationQuery, resourceId: string): Promise<ConfigurationEntry> {
  const [entry] = await query<ConfigurationEntry>({
    sql: `SELECT namespace, entry_key AS key, resource_id AS resourceId, retired, value
      FROM configuration_entries WHERE resource_id = ? AND namespace = 'SUBS' AND entry_key LIKE 'sub:sha256:%'`,
    params: [resourceId],
  })
  if (!entry) throw new ConfigurationError('not_found', 'Subscription not found')
  return { ...entry, retired: Boolean(entry.retired) }
}

export async function readConfiguration(env: Env, principal: ManagementPrincipal) {
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  return {
    ...state, canConfigure: state.mode === CONFIGURATION_MODE.ACTIVE && principal.capabilities.includes('configure'),
    supported: { policy: true, create: false, retire: false }, observedAt: new Date().toISOString(),
  }
}

export async function readConfigurationSubscription(env: Env, resourceId: string) {
  const query = configurationQuery(env.EVENTS_DB)
  const state = await activeState(query)
  const entry = await subscription(query, resourceId)
  const observed = await readConfigurationState(query)
  if (observed.authorityId !== state.authorityId || observed.revision !== state.revision || observed.mode !== state.mode) {
    throw new ConfigurationError('conflict', 'Configuration changed; refresh the subscription')
  }
  return { ...state, ...readSubscriptionPolicy(entry), observedAt: new Date().toISOString() }
}

export async function readConfigurationPage(
  env: Env, kind: 'subscriptions' | 'sinks', input: { cursor: string | null; revision: number },
) {
  const query = configurationQuery(env.EVENTS_DB)
  const state = await activeState(query)
  if (state.revision !== input.revision) throw new ConfigurationError('conflict', 'Configuration changed; restart pagination')
  const rows = await query<ConfigurationEntry>({
    sql: `SELECT namespace, entry_key AS key, resource_id AS resourceId, retired, value FROM configuration_entries
      WHERE namespace = ? AND entry_key LIKE ? AND resource_id > ? ORDER BY resource_id LIMIT ?`,
    params: [kind === 'subscriptions' ? 'SUBS' : 'SINKS', kind === 'subscriptions' ? 'sub:sha256:%' : 'sink:%',
      input.cursor ?? '', CONFIGURATION_LIMITS.PAGE_SIZE + 1],
  })
  const observed = await readConfigurationState(query)
  if (observed.authorityId !== state.authorityId || observed.revision !== state.revision || observed.mode !== state.mode) {
    throw new ConfigurationError('conflict', 'Configuration changed; restart pagination')
  }
  const candidates = rows.slice(0, CONFIGURATION_LIMITS.PAGE_SIZE)
  const items = candidates.map(entry => {
    if (kind === 'subscriptions') return readSubscriptionPolicy(entry)
    try {
      const value = JSON.parse(entry.value) as Record<string, unknown>
      return { resourceId: entry.resourceId, name: policyName.parse(entry.key.slice('sink:'.length)), type: policyName.parse(value.type), retired: Boolean(entry.retired) }
    } catch {
      throw new ConfigurationError('unavailable', 'Destination metadata could not be read safely')
    }
  })
  return {
    ...state, items,
    nextCursor: rows.length > CONFIGURATION_LIMITS.PAGE_SIZE ? candidates.at(-1)!.resourceId : null,
    observedAt: new Date().toISOString(),
  }
}

interface ReviewRow {
  id: string; authority_id: string; revision: number; client_id: string; client_revision: number;
  workspace_id: string; actor_id: string; resource_id: string; resource_name: string; input_hash: string;
  before_json: string; after_json: string; created_at: string; expires_at: string;
}

async function findReview(query: ConfigurationQuery, principal: ManagementPrincipal, context: ManagementContext, id: string) {
  const [review] = await query<ReviewRow>({ sql: 'SELECT * FROM configuration_policy_reviews WHERE id = ?', params: [id] })
  if (!review) return null
  if (review.client_id !== principal.id || review.client_revision !== principal.revision ||
      review.workspace_id !== context.workspaceId || review.actor_id !== context.actorId) {
    throw new ConfigurationError('not_found', 'Configuration review not found')
  }
  return review
}

async function reviewResult(query: ConfigurationQuery, principal: ManagementPrincipal, context: ManagementContext, review: ReviewRow) {
  const expired = Date.parse(review.expires_at) <= Date.now()
  let receipt = await readConfigurationReceipt(query, review.id, owner(principal, context))
  const state = await readConfigurationState(query)
  const changed = state.authorityId !== review.authority_id || state.revision !== review.revision
  if (!receipt && (expired || changed)) {
    // Acceptance can race the first receipt read; terminal evidence must follow the state check
    receipt = await readConfigurationReceipt(query, review.id, owner(principal, context))
  }
  const status = receipt ? 'accepted' : expired ? 'expired' : changed ? 'conflict' : 'ready'
  return {
    planId: review.id, authorityId: review.authority_id, revision: review.revision,
    resourceId: review.resource_id, resourceName: review.resource_name, status,
    before: subscriptionPolicySchema.parse(JSON.parse(review.before_json)),
    after: subscriptionPolicySchema.parse(JSON.parse(review.after_json)),
    createdAt: review.created_at, expiresAt: review.expires_at,
    receipt: receipt ? { operationId: receipt.id, revision: receipt.revision, acceptedAt: receipt.acceptedAt } : null,
    effect: 'future-ingress-policy' as const,
  }
}

type PlanInput = z.infer<typeof managementInputs.configuration_policy_plan>

export async function planConfigurationPolicy(env: Env, principal: ManagementPrincipal, input: PlanInput) {
  authorizeConfiguration(principal, input.workspaceId)
  const query = configurationQuery(env.EVENTS_DB)
  const context = { workspaceId: input.workspaceId, actorId: input.actorId }
  const inputHash = await configurationDigest({ ...input, ...owner(principal, context) })
  const previous = await findReview(query, principal, context, input.planId)
  if (previous) {
    if (previous.input_hash !== inputHash) throw new ConfigurationError('conflict', 'The review ID belongs to different inputs')
    return reviewResult(query, principal, context, previous)
  }
  const state = await activeState(query)
  if (state.authorityId !== input.authorityId || state.revision !== input.revision) {
    throw new ConfigurationError('conflict', 'Configuration changed; refresh the subscription and review again')
  }
  const entry = await subscription(query, input.resourceId)
  const before = readSubscriptionPolicy(entry)
  if (canonicalConfiguration(before.policy) === canonicalConfiguration(input.policy)) {
    throw new ConfigurationError('validation', 'The subscription policy is unchanged')
  }
  const destinations = await query<{ name: string; retired: number }>({
    sql: `SELECT substr(entry_key, 6) AS name, retired FROM configuration_entries
      WHERE namespace = 'SINKS' AND entry_key IN (SELECT 'sink:' || value FROM json_each(?)) LIMIT ?`,
    params: [JSON.stringify(input.policy.sinks), CONFIGURATION_LIMITS.ENTRIES],
  })
  if (destinations.length !== input.policy.sinks.length || (input.policy.enabled && destinations.some(entry => entry.retired))) {
    throw new ConfigurationError('validation', 'Select existing, non-retired destinations before enabling the subscription')
  }
  const createdAt = new Date().toISOString()
  const expiresAt = new Date(Math.min(Date.now() + CONFIGURATION_LIMITS.REVIEW_TTL_MS, Date.parse(principal.expiresAt))).toISOString()
  await query({
    sql: `INSERT INTO configuration_policy_reviews (
      id, authority_id, revision, client_id, client_revision, workspace_id, actor_id, resource_id,
      resource_name, input_hash, before_json, after_json, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM configuration_authority WHERE authority_id = ? AND revision = ? AND mode = 'active')
      AND julianday(?) > julianday('now')
      AND (SELECT count(*) FROM configuration_policy_reviews AS review
        WHERE client_id = ? AND expires_at > ?
          AND NOT EXISTS (SELECT 1 FROM configuration_receipts WHERE id = review.id)) < ?
    ON CONFLICT (id) DO NOTHING RETURNING id`,
    params: [input.planId, state.authorityId, state.revision, principal.id, principal.revision, input.workspaceId, input.actorId,
      input.resourceId, before.name, inputHash, canonicalConfiguration(before.policy), canonicalConfiguration(input.policy), createdAt, expiresAt,
      state.authorityId, state.revision, expiresAt, principal.id, createdAt, CONFIGURATION_LIMITS.PENDING_REVIEWS],
  })
  const saved = await findReview(query, principal, context, input.planId)
  if (!saved) throw new ManagementError('review_unavailable', 409, 'Configuration changed or the pending review limit was reached; refresh before reviewing again')
  if (saved.input_hash !== inputHash) throw new ConfigurationError('conflict', 'The review ID belongs to different inputs')
  return reviewResult(query, principal, context, saved)
}

export async function readConfigurationPolicy(env: Env, principal: ManagementPrincipal, input: ManagementContext & { planId: string }) {
  authorizeManagement(principal, input.workspaceId)
  const query = configurationQuery(env.EVENTS_DB)
  const review = await findReview(query, principal, input, input.planId)
  if (!review) throw new ConfigurationError('not_found', 'Configuration review not found')
  return reviewResult(query, principal, input, review)
}

export async function applyConfigurationPolicy(env: Env, principal: ManagementPrincipal, input: ManagementContext & { planId: string }) {
  authorizeConfiguration(principal, input.workspaceId)
  const query = configurationQuery(env.EVENTS_DB)
  const context = { workspaceId: input.workspaceId, actorId: input.actorId }
  const review = await findReview(query, principal, context, input.planId)
  if (!review) throw new ConfigurationError('not_found', 'Configuration review not found')
  const reviewed = await reviewResult(query, principal, context, review)
  if (reviewed.status === 'accepted') return reviewed
  if (reviewed.status === 'expired') throw new ConfigurationError('expired', 'The configuration review expired; review again')
  if (reviewed.status !== 'ready') throw new ConfigurationError('conflict', 'Configuration changed; review again')
  const entry = await subscription(query, review.resource_id)
  authorizeConfiguration(principal, input.workspaceId)
  await acceptConfigurationChange(query, {
    ...owner(principal, context), authorityId: review.authority_id, expectedRevision: review.revision,
    operationId: review.id, kind: 'policy', resourceId: review.resource_id, expiresAt: review.expires_at,
    puts: [applySubscriptionPolicy(entry, reviewed.after)], deletes: [],
  })
  return reviewResult(query, principal, context, review)
}

export async function pruneConfigurationReviews(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - CONFIGURATION_LIMITS.RECEIPT_DAYS * 86400000).toISOString()
  const query = configurationQuery(env.EVENTS_DB)
  await query({
    sql: `DELETE FROM configuration_policy_reviews WHERE id IN (
      SELECT id FROM configuration_policy_reviews WHERE expires_at < ? ORDER BY expires_at LIMIT ?
    )`, params: [cutoff, CONFIGURATION_LIMITS.PRUNE_BATCH],
  })
  await query({
    sql: `DELETE FROM configuration_receipts WHERE id IN (
      SELECT id FROM configuration_receipts AS receipt WHERE accepted_at < ?
        AND NOT EXISTS (SELECT 1 FROM configuration_policy_reviews WHERE id = receipt.id)
      ORDER BY accepted_at LIMIT ?
    )`, params: [cutoff, CONFIGURATION_LIMITS.PRUNE_BATCH],
  })
}
