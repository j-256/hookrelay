import type { Env } from './index'
import type { FanoutResult, NormalizedEvent } from './types'

export interface PersistResult {
  duplicate: boolean
  r2Keys: { raw: string; json: string }
  receivedAt: string
}

export function primaryKey(event: Pick<NormalizedEvent, 'source' | 'id'>): string {
  return `${event.source}:${event.id}`
}

export function r2Keys(
  event: Pick<NormalizedEvent, 'source' | 'id'>,
  receivedAtIso: string,
): { raw: string; json: string } {
  const date = receivedAtIso.slice(0, 10).split('-')
  const safe = primaryKey(event).replace(/[/:]/g, '_')
  const prefix = `events/${date[0]}/${date[1]}/${date[2]}/${safe}`
  return { raw: `${prefix}.raw`, json: `${prefix}.json` }
}

export function normalizedR2Key(rawKey: string): string {
  return rawKey.endsWith('.raw') ? `${rawKey.slice(0, -4)}.json` : `${rawKey}.json`
}

async function persistR2Objects(
  env: Env,
  keys: { raw: string; json: string },
  event: NormalizedEvent,
  rawBody: Uint8Array,
  contentType: string,
  onlyIfMissing = false,
): Promise<void> {
  try {
    const existing = onlyIfMissing
      ? await Promise.all([env.EVENTS_RAW.head(keys.raw), env.EVENTS_RAW.head(keys.json)])
      : [null, null]
    const writes: Promise<unknown>[] = []
    if (!existing[0]) {
      writes.push(env.EVENTS_RAW.put(keys.raw, rawBody, {
        httpMetadata: { contentType },
      }))
    }
    if (!existing[1]) {
      writes.push(env.EVENTS_RAW.put(keys.json, JSON.stringify(event), {
        httpMetadata: { contentType: 'application/json' },
      }))
    }
    await Promise.all(writes)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify({
      level: 'error',
      msg: 'persist.r2.failed',
      eventId: primaryKey(event),
      r2Key: keys.raw,
      errMsg,
    }))
    throw new Error(`R2 put failed after D1 insert (orphan row ${primaryKey(event)}): ${errMsg}`)
  }
}

export async function persistEvent(
  env: Env,
  event: NormalizedEvent,
  rawBody: Uint8Array,
  contentType: string,
  subSlug: string,
): Promise<PersistResult> {
  const receivedAt = new Date().toISOString()
  const keys = r2Keys(event, receivedAt)
  const id = primaryKey(event)

  const insert = await env.EVENTS_DB.prepare(
    `INSERT OR IGNORE INTO events
       (id, received_at, sender_at, sub_slug, sub_name, source, type, title, url, severity, r2_key, fanout_results)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
  )
    .bind(
      id,
      receivedAt,
      event.timestamp,
      subSlug,
      event.subName,
      event.source,
      event.type,
      event.title,
      event.url ?? null,
      event.severity ?? null,
      keys.raw,
    )
    .run()

  if (insert.meta.changes === 0) {
    const existing = await env.EVENTS_DB.prepare('SELECT received_at, r2_key FROM events WHERE id = ?')
      .bind(id)
      .first<{ received_at: string; r2_key: string }>()
    if (!existing) throw new Error(`duplicate event row disappeared: ${id}`)
    const existingKeys = { raw: existing.r2_key, json: normalizedR2Key(existing.r2_key) }
    await persistR2Objects(env, existingKeys, event, rawBody, contentType, true)
    return { duplicate: true, r2Keys: existingKeys, receivedAt: existing.received_at }
  }

  await persistR2Objects(env, keys, event, rawBody, contentType)

  return { duplicate: false, r2Keys: keys, receivedAt }
}

export async function loadNormalizedEvent(env: Env, eventId: string): Promise<NormalizedEvent> {
  const row = await env.EVENTS_DB.prepare('SELECT r2_key FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ r2_key: string }>()
  if (!row) throw new Error(`event not found: ${eventId}`)
  const obj = await env.EVENTS_RAW.get(normalizedR2Key(row.r2_key))
  if (!obj) throw new Error(`normalized event missing from R2: ${eventId}`)
  return JSON.parse(await obj.text()) as NormalizedEvent
}

export async function updateFanoutResult(
  env: Env,
  eventId: string,
  sinkName: string,
  result: FanoutResult,
): Promise<void> {
  await env.EVENTS_DB.prepare(
    `UPDATE events
     SET fanout_results = json_patch(fanout_results, json_object(?, json(?)))
     WHERE id = ?`,
  )
    .bind(sinkName, JSON.stringify(result), eventId)
    .run()
}
