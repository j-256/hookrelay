import type { Env } from '../index'
import { enqueueReviewedDelivery } from '../delivery'
import { normalizedR2Key } from '../persistence'
import { authorizeManagement, type ManagementPrincipal } from './access'
import {
  MANAGEMENT_LIMITS, ManagementError, type ManagementContext, type RetryInput,
} from './contract'

interface PlanRow {
  id: string
  client_id: string
  client_revision: number
  workspace_id: string
  actor_id: string
  event_id: string
  sink_name: string
  expected_generation: number
  expected_updated_at: string
  created_at: string
  expires_at: string
  applied_at: string | null
  accepted_generation: number | null
}

function receipt(plan: PlanRow) {
  return {
    planId: plan.id,
    eventId: plan.event_id,
    sinkName: plan.sink_name,
    generation: plan.expected_generation,
    updatedAt: plan.expected_updated_at,
    createdAt: plan.created_at,
    expiresAt: plan.expires_at,
    state: plan.applied_at ? 'accepted' as const
      : Date.parse(plan.expires_at) <= Date.now() ? 'expired' as const : 'review' as const,
    acceptedAt: plan.applied_at,
    acceptedGeneration: plan.accepted_generation,
  }
}

async function findPlan(env: Env, principal: ManagementPrincipal, input: ManagementContext, planId: string) {
  return env.EVENTS_DB.prepare(
    `SELECT id, client_id, client_revision, workspace_id, actor_id, event_id, sink_name,
            expected_generation, expected_updated_at, created_at, expires_at, applied_at, accepted_generation
     FROM management_retry_plans WHERE id = ? AND client_id = ? AND client_revision = ?
       AND workspace_id = ? AND actor_id = ?`,
  ).bind(planId, principal.id, principal.revision, input.workspaceId, input.actorId).first<PlanRow>()
}

async function requirePayload(env: Env, eventId: string) {
  const event = await env.EVENTS_DB.prepare('SELECT r2_key FROM events WHERE id = ?')
    .bind(eventId).first<{ r2_key: string }>()
  if (!event) throw new ManagementError('not_found', 404, 'Delivery event not found')
  if (!(await env.EVENTS_RAW.head(normalizedR2Key(event.r2_key)))) {
    throw new ManagementError('payload_unavailable', 409, 'The retained event required for retry is unavailable')
  }
}

export async function readRetry(env: Env, principal: ManagementPrincipal, input: ManagementContext & { planId: string }) {
  const plan = await findPlan(env, principal, input, input.planId)
  if (!plan) throw new ManagementError('not_found', 404, 'Retry review not found')
  return receipt(plan)
}

export async function planRetry(env: Env, principal: ManagementPrincipal, input: RetryInput) {
  const existing = await findPlan(env, principal, input, input.planId)
  if (existing) {
    if (existing.event_id !== input.eventId || existing.sink_name !== input.sinkName ||
        existing.expected_generation !== input.generation || existing.expected_updated_at !== input.updatedAt) {
      throw new ManagementError('conflict', 409, 'This review identity is already bound to different delivery state')
    }
    return receipt(existing)
  }
  await requirePayload(env, input.eventId)
  authorizeManagement(principal, input.workspaceId, true)
  const timestamp = new Date().toISOString()
  const expiresAt = new Date(Date.now() + MANAGEMENT_LIMITS.PLAN_TTL_MS).toISOString()
  await env.EVENTS_DB.prepare(
    `INSERT OR IGNORE INTO management_retry_plans
       (id, client_id, client_revision, workspace_id, actor_id, event_id, sink_name,
        expected_generation, expected_updated_at, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, event_id, sink_name, generation, updated_at, ?, ?
       FROM deliveries WHERE event_id = ? AND sink_name = ? AND status = 'exhausted'
         AND generation = ? AND updated_at = ?
         AND (SELECT COUNT(*) FROM (
           SELECT id FROM management_retry_plans WHERE client_id = ? AND workspace_id = ?
             AND actor_id = ? AND expires_at > ? AND applied_at IS NULL LIMIT ?
         )) < ?`,
  ).bind(
    input.planId, principal.id, principal.revision, input.workspaceId, input.actorId, timestamp, expiresAt,
    input.eventId, input.sinkName, input.generation, input.updatedAt,
    principal.id, input.workspaceId, input.actorId, timestamp, MANAGEMENT_LIMITS.PENDING_PLANS,
    MANAGEMENT_LIMITS.PENDING_PLANS,
  ).run()
  const plan = await findPlan(env, principal, input, input.planId)
  if (!plan) {
    throw new ManagementError('conflict', 409, 'Delivery state changed or the pending review limit was reached; refresh before reviewing again')
  }
  if (plan.event_id !== input.eventId || plan.sink_name !== input.sinkName ||
      plan.expected_generation !== input.generation || plan.expected_updated_at !== input.updatedAt) {
    throw new ManagementError('conflict', 409, 'This review identity is already bound to different delivery state')
  }
  return receipt(plan)
}

export async function applyRetry(env: Env, principal: ManagementPrincipal, input: ManagementContext & { planId: string }) {
  const plan = await findPlan(env, principal, input, input.planId)
  if (!plan) throw new ManagementError('not_found', 404, 'Retry review not found')
  if (plan.applied_at) return receipt(plan)
  if (Date.parse(plan.expires_at) <= Date.now()) {
    throw new ManagementError('expired', 409, 'The retry review expired; inspect the delivery and review again')
  }
  await requirePayload(env, plan.event_id)
  authorizeManagement(principal, input.workspaceId, true)
  const timestamp = new Date().toISOString()
  const writeId = crypto.randomUUID()
  const results = await env.EVENTS_DB.batch([
    env.EVENTS_DB.prepare(
      `UPDATE management_retry_plans SET applied_at = ?, write_id = ?,
         accepted_generation = expected_generation + 1
       WHERE id = ? AND client_id = ? AND client_revision = ? AND workspace_id = ? AND actor_id = ?
         AND applied_at IS NULL AND expires_at > ? AND julianday(expires_at) > julianday('now') AND EXISTS (
           SELECT 1 FROM deliveries d WHERE d.event_id = management_retry_plans.event_id
             AND d.sink_name = management_retry_plans.sink_name AND d.status = 'exhausted'
             AND d.generation = management_retry_plans.expected_generation
             AND d.updated_at = management_retry_plans.expected_updated_at
         )`,
    ).bind(timestamp, writeId, plan.id, principal.id, principal.revision, input.workspaceId, input.actorId, timestamp),
    env.EVENTS_DB.prepare(
      `UPDATE deliveries SET status = 'pending', generation = generation + 1,
         last_error = NULL, updated_at = ?, delivered_at = NULL, lease_until = NULL
       WHERE event_id = ? AND sink_name = ? AND generation = ? AND updated_at = ? AND status = 'exhausted'
         AND EXISTS (SELECT 1 FROM management_retry_plans WHERE id = ? AND write_id = ?)`,
    ).bind(timestamp, plan.event_id, plan.sink_name, plan.expected_generation, plan.expected_updated_at, plan.id, writeId),
    env.EVENTS_DB.prepare(
      `UPDATE operational_signals SET resolved_at = ?
       WHERE event_id = ? AND sink_name = ? AND resolved_at IS NULL
         AND code IN ('delivery-exhausted', 'delivery-stale')
         AND EXISTS (SELECT 1 FROM management_retry_plans WHERE id = ? AND write_id = ?)`,
    ).bind(timestamp, plan.event_id, plan.sink_name, plan.id, writeId),
  ])
  const accepted = await findPlan(env, principal, input, plan.id)
  if (!accepted?.applied_at || accepted.accepted_generation === null) {
    throw new ManagementError('conflict', 409, 'Delivery state changed; inspect the delivery and review again')
  }
  if (results[0]!.meta.changes > 0) {
    // Acceptance and the pending outbox state are already durable before queue publication
    try {
      await enqueueReviewedDelivery(env, plan.event_id, plan.sink_name, accepted.accepted_generation)
    } catch {
      console.log(JSON.stringify({ level: 'warn', msg: 'management.retry.publication_deferred' }))
    }
  }
  return receipt(accepted)
}

export async function pruneManagementReceipts(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - MANAGEMENT_LIMITS.RECEIPT_DAYS * 86400000).toISOString()
  await env.EVENTS_DB.prepare(
    `DELETE FROM management_retry_plans WHERE id IN (
       SELECT id FROM management_retry_plans WHERE expires_at < ? ORDER BY expires_at LIMIT ?
     )`,
  ).bind(cutoff, MANAGEMENT_LIMITS.PRUNE_BATCH).run()
}
