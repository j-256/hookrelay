import { dispatchSink } from './fanout'
import type { Env } from './index'
import { loadNormalizedEvent, updateFanoutResult } from './persistence'
import type { DeliveryMessage, DeliveryStatus, FanoutResult, FanoutResults } from './types'

export const DELIVERY_QUEUE_NAME = 'hookrelay-delivery'
export const DELIVERY_DLQ_NAME = 'hookrelay-delivery-dlq'

const DELIVERY_MESSAGE_VERSION = 1
const OUTBOX_BATCH_SIZE = 100
const PROCESSING_LEASE_SECONDS = 60
const RETRY_BASE_SECONDS = 30
const RETRY_MAX_SECONDS = 3600

interface DeliveryRow {
  event_id: string
  sink_name: string
  generation: number
  status: DeliveryStatus
  attempts: number
  last_error: string | null
  lease_until: string | null
}

export interface EnqueueSummary {
  queued: number
  deferred: number
}

export interface RedriveResult {
  ok: boolean
  reason?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function displayResult(
  status: DeliveryStatus,
  attempts: number,
  updatedAt: string,
  errMsg?: string,
): FanoutResult {
  return {
    ok: status === 'delivered',
    status,
    attempts,
    ...(errMsg ? { errMsg } : {}),
    updatedAt,
  }
}

function queueMessage(
  row: Pick<DeliveryRow, 'event_id' | 'sink_name' | 'generation'>,
): DeliveryMessage {
  return {
    version: DELIVERY_MESSAGE_VERSION,
    eventId: row.event_id,
    sinkName: row.sink_name,
    generation: row.generation,
  }
}

function parseQueueMessage(value: unknown): DeliveryMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const message = value as Record<string, unknown>
  if (
    message.version !== DELIVERY_MESSAGE_VERSION ||
    typeof message.eventId !== 'string' ||
    message.eventId.length === 0 ||
    typeof message.sinkName !== 'string' ||
    message.sinkName.length === 0 ||
    typeof message.generation !== 'number' ||
    !Number.isInteger(message.generation) ||
    message.generation < 1
  ) return null
  return {
    version: DELIVERY_MESSAGE_VERSION,
    eventId: message.eventId,
    sinkName: message.sinkName,
    generation: message.generation,
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function parseFanoutResults(value: string): FanoutResults {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as FanoutResults
    }
  } catch {}
  return {}
}

async function recordDisplayResult(
  env: Env,
  eventId: string,
  sinkName: string,
  result: FanoutResult,
): Promise<void> {
  try {
    await updateFanoutResult(env, eventId, sinkName, result)
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'delivery.display.failed',
      eventId,
      sinkName,
      errMsg: errMsg(err),
    }))
  }
}

export function retryDelaySeconds(attempts: number, retryAfterSeconds?: number): number {
  const exponent = Math.max(0, attempts - 1)
  const backoff = Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** exponent))
  if (
    retryAfterSeconds === undefined ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds < 0
  ) return backoff
  return Math.min(RETRY_MAX_SECONDS, Math.max(backoff, retryAfterSeconds))
}

async function getDelivery(
  env: Env,
  eventId: string,
  sinkName: string,
): Promise<DeliveryRow | null> {
  return env.EVENTS_DB.prepare(
    `SELECT event_id, sink_name, generation, status, attempts, last_error, lease_until
     FROM deliveries WHERE event_id = ? AND sink_name = ?`,
  )
    .bind(eventId, sinkName)
    .first<DeliveryRow>()
}

export async function ensureDeliveryRows(
  env: Env,
  eventId: string,
  sinkNames: string[],
): Promise<void> {
  const uniqueSinkNames = [...new Set(sinkNames)]
  if (uniqueSinkNames.length === 0) return
  const event = await env.EVENTS_DB.prepare(
    'SELECT received_at, fanout_results FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<{ received_at: string; fanout_results: string }>()
  if (!event) throw new Error(`event not found while creating deliveries: ${eventId}`)
  const legacy = parseFanoutResults(event.fanout_results)
  for (let offset = 0; offset < uniqueSinkNames.length; offset += OUTBOX_BATCH_SIZE) {
    const chunk = uniqueSinkNames.slice(offset, offset + OUTBOX_BATCH_SIZE)
    await env.EVENTS_DB.batch(
      chunk.map((sinkName) => {
        const result = legacy[sinkName]
        const status: DeliveryStatus = result
          ? result.ok ? 'delivered' : 'exhausted'
          : 'pending'
        const attempts = typeof result?.attempts === 'number' &&
          Number.isInteger(result.attempts) &&
          result.attempts >= 0
          ? result.attempts
          : 0
        const updatedAt = result?.updatedAt ?? event.received_at
        return env.EVENTS_DB.prepare(
          `INSERT OR IGNORE INTO deliveries
           (event_id, sink_name, status, attempts, last_error, created_at, updated_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          eventId,
          sinkName,
          status,
          attempts,
          result?.errMsg ?? null,
          event.received_at,
          updatedAt,
          status === 'delivered' ? updatedAt : null,
        )
      }),
    )
  }
}

async function pendingDeliveries(env: Env, eventId?: string): Promise<DeliveryRow[]> {
  const statement = eventId
    ? env.EVENTS_DB.prepare(
        `SELECT event_id, sink_name, generation, status, attempts, last_error, lease_until
         FROM deliveries
         WHERE status = 'pending' AND event_id = ?
         ORDER BY updated_at ASC LIMIT ?`,
      ).bind(eventId, OUTBOX_BATCH_SIZE)
    : env.EVENTS_DB.prepare(
        `SELECT event_id, sink_name, generation, status, attempts, last_error, lease_until
         FROM deliveries
         WHERE status = 'pending'
         ORDER BY updated_at ASC LIMIT ?`,
      ).bind(OUTBOX_BATCH_SIZE)
  const result = await statement.all<DeliveryRow>()
  return result.results ?? []
}

async function markQueued(env: Env, row: DeliveryRow): Promise<boolean> {
  const timestamp = nowIso()
  const updated = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'queued', last_error = NULL, updated_at = ?
     WHERE event_id = ? AND sink_name = ? AND generation = ? AND status = 'pending'`,
  )
    .bind(timestamp, row.event_id, row.sink_name, row.generation)
    .run()
  if (updated.meta.changes === 0) return false
  await recordDisplayResult(
    env,
    row.event_id,
    row.sink_name,
    displayResult('queued', row.attempts, timestamp),
  )
  return true
}

async function markEnqueueFailure(env: Env, row: DeliveryRow, error: string): Promise<void> {
  const timestamp = nowIso()
  const updated = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET last_error = ?, updated_at = ?
     WHERE event_id = ? AND sink_name = ? AND generation = ? AND status = 'pending'`,
  )
    .bind(error, timestamp, row.event_id, row.sink_name, row.generation)
    .run()
  if (updated.meta.changes === 0) return
  await recordDisplayResult(
    env,
    row.event_id,
    row.sink_name,
    displayResult('pending', row.attempts, timestamp, error),
  )
}

async function reservePendingForPublish(
  env: Env,
  row: DeliveryRow,
): Promise<DeliveryRow | null> {
  const timestamp = nowIso()
  const reserved = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET generation = generation + 1, updated_at = ?
     WHERE event_id = ? AND sink_name = ? AND generation = ? AND status = 'pending'`,
  )
    .bind(timestamp, row.event_id, row.sink_name, row.generation)
    .run()
  if (reserved.meta.changes === 0) return null
  return { ...row, generation: row.generation + 1 }
}

async function publishPendingRows(env: Env, rows: DeliveryRow[]): Promise<EnqueueSummary> {
  let queued = 0
  let deferred = 0
  for (let offset = 0; offset < rows.length; offset += OUTBOX_BATCH_SIZE) {
    const chunk = rows.slice(offset, offset + OUTBOX_BATCH_SIZE)
    const reserved: DeliveryRow[] = []
    for (const row of chunk) {
      try {
        const current = await reservePendingForPublish(env, row)
        if (current) reserved.push(current)
      } catch (err) {
        deferred += 1
        console.log(JSON.stringify({
          level: 'error',
          msg: 'delivery.enqueue.reserve_failed',
          eventId: row.event_id,
          sinkName: row.sink_name,
          errMsg: errMsg(err),
        }))
      }
    }
    if (reserved.length === 0) continue
    try {
      await env.DELIVERY_QUEUE.sendBatch(reserved.map((row) => ({ body: queueMessage(row) })))
      for (const row of reserved) {
        if (await markQueued(env, row)) queued += 1
      }
    } catch (err) {
      const error = `queue enqueue failed: ${errMsg(err)}`
      deferred += reserved.length
      console.log(JSON.stringify({
        level: 'error',
        msg: 'delivery.enqueue.deferred',
        count: reserved.length,
        errMsg: error,
      }))
      for (const row of reserved) await markEnqueueFailure(env, row, error)
    }
  }
  return { queued, deferred }
}

export async function enqueuePendingDeliveries(
  env: Env,
  eventId?: string,
): Promise<EnqueueSummary> {
  return publishPendingRows(env, await pendingDeliveries(env, eventId))
}

export async function prepareDeliveries(
  env: Env,
  eventId: string,
  sinkNames: string[],
): Promise<EnqueueSummary> {
  await ensureDeliveryRows(env, eventId, sinkNames)
  return enqueuePendingDeliveries(env, eventId)
}

type ClaimResult =
  | { kind: 'claimed'; row: DeliveryRow }
  | { kind: 'busy' }
  | { kind: 'skip'; status?: DeliveryStatus }

async function claimDelivery(
  env: Env,
  eventId: string,
  sinkName: string,
  generation: number,
): Promise<ClaimResult> {
  const timestamp = nowIso()
  const leaseUntil = new Date(Date.now() + PROCESSING_LEASE_SECONDS * 1000).toISOString()
  const claimed = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'processing', attempts = attempts + 1, updated_at = ?, lease_until = ?
     WHERE event_id = ? AND sink_name = ?
       AND generation = ?
       AND status IN ('pending', 'queued', 'processing', 'retrying')
       AND (status != 'processing' OR lease_until IS NULL OR lease_until <= ?)`,
  )
    .bind(timestamp, leaseUntil, eventId, sinkName, generation, timestamp)
    .run()
  if (claimed.meta.changes > 0) {
    const row = await getDelivery(env, eventId, sinkName)
    if (!row) throw new Error(`claimed delivery disappeared: ${eventId} / ${sinkName}`)
    await recordDisplayResult(
      env,
      eventId,
      sinkName,
      displayResult('processing', row.attempts, timestamp),
    )
    return { kind: 'claimed', row }
  }

  const existing = await getDelivery(env, eventId, sinkName)
  if (existing?.generation === generation && existing.status === 'processing') {
    return { kind: 'busy' }
  }
  return { kind: 'skip', status: existing?.status }
}

async function markDelivered(env: Env, row: DeliveryRow): Promise<boolean> {
  const timestamp = nowIso()
  const updated = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'delivered', last_error = NULL, updated_at = ?, delivered_at = ?, lease_until = NULL
     WHERE event_id = ? AND sink_name = ? AND generation = ?
       AND status = 'processing' AND attempts = ? AND lease_until = ?`,
  )
    .bind(
      timestamp,
      timestamp,
      row.event_id,
      row.sink_name,
      row.generation,
      row.attempts,
      row.lease_until,
    )
    .run()
  if (updated.meta.changes === 0) return false
  await recordDisplayResult(
    env,
    row.event_id,
    row.sink_name,
    displayResult('delivered', row.attempts, timestamp),
  )
  return true
}

async function markRetrying(env: Env, row: DeliveryRow, error: string): Promise<boolean> {
  const timestamp = nowIso()
  const updated = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'retrying', last_error = ?, updated_at = ?, lease_until = NULL
     WHERE event_id = ? AND sink_name = ? AND generation = ?
       AND status = 'processing' AND attempts = ? AND lease_until = ?`,
  )
    .bind(
      error,
      timestamp,
      row.event_id,
      row.sink_name,
      row.generation,
      row.attempts,
      row.lease_until,
    )
    .run()
  if (updated.meta.changes === 0) return false
  await recordDisplayResult(
    env,
    row.event_id,
    row.sink_name,
    displayResult('retrying', row.attempts, timestamp, error),
  )
  return true
}

async function consumeDeliveryMessage(message: Message<unknown>, env: Env): Promise<void> {
  const body = parseQueueMessage(message.body)
  if (!body) {
    console.log(JSON.stringify({ level: 'error', msg: 'delivery.message.invalid' }))
    message.ack()
    return
  }

  let claim: ClaimResult
  try {
    claim = await claimDelivery(env, body.eventId, body.sinkName, body.generation)
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'delivery.claim.failed',
      eventId: body.eventId,
      sinkName: body.sinkName,
      errMsg: errMsg(err),
    }))
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
    return
  }

  if (claim.kind === 'busy') {
    message.retry({ delaySeconds: PROCESSING_LEASE_SECONDS })
    return
  }
  if (claim.kind === 'skip') {
    message.ack()
    return
  }

  const { row } = claim
  try {
    const event = await loadNormalizedEvent(env, body.eventId)
    const result = await dispatchSink(env, event, body.sinkName)
    if (result.ok) {
      await markDelivered(env, row)
      message.ack()
      return
    }
    const error = result.errMsg ?? 'sink delivery failed'
    if (!(await markRetrying(env, row, error))) {
      message.ack()
      return
    }
    message.retry({
      delaySeconds: retryDelaySeconds(message.attempts, result.retryAfterSeconds),
    })
  } catch (err) {
    const error = errMsg(err)
    let recorded = false
    try {
      recorded = await markRetrying(env, row, error)
    } catch (stateErr) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'delivery.state.failed',
        eventId: body.eventId,
        sinkName: body.sinkName,
        errMsg: errMsg(stateErr),
      }))
    }
    if (!recorded) {
      const current = await getDelivery(env, body.eventId, body.sinkName).catch(() => null)
      if (current && (
        current.generation !== body.generation ||
        current.status === 'delivered' ||
        current.status === 'exhausted'
      )) {
        message.ack()
        return
      }
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
  }
}

async function markExhausted(env: Env, row: DeliveryRow): Promise<boolean> {
  const timestamp = nowIso()
  const error = row.last_error ?? 'automatic delivery retries exhausted'
  const updated = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'exhausted', last_error = ?, updated_at = ?, lease_until = NULL
     WHERE event_id = ? AND sink_name = ? AND generation = ?
       AND status = ? AND attempts = ?
       AND (status != 'processing' OR lease_until IS ?)`,
  )
    .bind(
      error,
      timestamp,
      row.event_id,
      row.sink_name,
      row.generation,
      row.status,
      row.attempts,
      row.lease_until,
    )
    .run()
  if (updated.meta.changes === 0) return false
  await recordDisplayResult(
    env,
    row.event_id,
    row.sink_name,
    displayResult('exhausted', row.attempts, timestamp, error),
  )
  return true
}

async function consumeDeadLetterMessage(message: Message<unknown>, env: Env): Promise<void> {
  const body = parseQueueMessage(message.body)
  if (!body) {
    console.log(JSON.stringify({ level: 'error', msg: 'delivery.dlq.invalid' }))
    message.ack()
    return
  }
  try {
    const row = await getDelivery(env, body.eventId, body.sinkName)
    if (
      !row ||
      row.generation !== body.generation ||
      row.status === 'delivered' ||
      row.status === 'exhausted'
    ) {
      message.ack()
      return
    }
    if (row.status === 'processing' && row.lease_until && row.lease_until > nowIso()) {
      message.retry({ delaySeconds: PROCESSING_LEASE_SECONDS })
      return
    }
    if (await markExhausted(env, row)) {
      message.ack()
      return
    }
    const current = await getDelivery(env, body.eventId, body.sinkName)
    if (
      !current ||
      current.generation !== body.generation ||
      current.status === 'delivered' ||
      current.status === 'exhausted'
    ) {
      message.ack()
      return
    }
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'delivery.dlq.failed',
      eventId: body.eventId,
      sinkName: body.sinkName,
      errMsg: errMsg(err),
    }))
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts) })
  }
}

export async function handleDeliveryBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) await consumeDeliveryMessage(message, env)
}

export async function handleDeadLetterBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) await consumeDeadLetterMessage(message, env)
}

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (batch.queue === DELIVERY_QUEUE_NAME) {
    await handleDeliveryBatch(batch, env)
    return
  }
  if (batch.queue === DELIVERY_DLQ_NAME) {
    await handleDeadLetterBatch(batch, env)
    return
  }
  console.log(JSON.stringify({ level: 'error', msg: 'delivery.queue.unknown', queue: batch.queue }))
  batch.retryAll()
}

export async function redriveDelivery(
  env: Env,
  eventId: string,
  sinkName: string,
): Promise<RedriveResult> {
  let row = await getDelivery(env, eventId, sinkName)
  if (!row) {
    const event = await env.EVENTS_DB.prepare('SELECT fanout_results FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ fanout_results: string }>()
    if (!event) return { ok: false, reason: 'event not found' }
    const legacy = parseFanoutResults(event.fanout_results)
    if (legacy[sinkName]?.ok !== false) return { ok: false, reason: 'failed delivery not found' }
    await ensureDeliveryRows(env, eventId, [sinkName])
    row = await getDelivery(env, eventId, sinkName)
  }
  if (!row) return { ok: false, reason: 'delivery not found' }
  if (row.status !== 'exhausted' && row.status !== 'pending') {
    return { ok: false, reason: `delivery is ${row.status}` }
  }

  const timestamp = nowIso()
  const reset = await env.EVENTS_DB.prepare(
    `UPDATE deliveries
     SET status = 'pending', last_error = NULL, updated_at = ?,
         delivered_at = NULL, lease_until = NULL
     WHERE event_id = ? AND sink_name = ? AND generation = ? AND status = ?`,
  )
    .bind(timestamp, eventId, sinkName, row.generation, row.status)
    .run()
  if (reset.meta.changes === 0) {
    const current = await getDelivery(env, eventId, sinkName)
    return { ok: false, reason: current ? `delivery is ${current.status}` : 'delivery not found' }
  }
  const pending = await getDelivery(env, eventId, sinkName)
  if (!pending) return { ok: false, reason: 'delivery not found after reset' }
  await recordDisplayResult(
    env,
    eventId,
    sinkName,
    displayResult('pending', pending.attempts, timestamp),
  )
  await publishPendingRows(env, [pending])
  return { ok: true }
}
