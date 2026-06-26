import type { Env } from './index'
import type { FanoutResults, NormalizedEvent } from './types'

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
    return { duplicate: true, r2Keys: keys, receivedAt }
  }

  try {
    await Promise.all([
      env.EVENTS_RAW.put(keys.raw, rawBody, {
        httpMetadata: { contentType },
      }),
      env.EVENTS_RAW.put(keys.json, JSON.stringify(event), {
        httpMetadata: { contentType: 'application/json' },
      }),
    ])
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify({
      level: 'error',
      msg: 'persist.r2.failed',
      eventId: id,
      r2Key: keys.raw,
      errMsg,
    }))
    throw new Error(`R2 put failed after D1 insert (orphan row ${id}): ${errMsg}`)
  }

  return { duplicate: false, r2Keys: keys, receivedAt }
}

export async function updateFanoutResults(
  env: Env,
  eventId: string,
  results: FanoutResults,
): Promise<void> {
  await env.EVENTS_DB.prepare('UPDATE events SET fanout_results = ? WHERE id = ?')
    .bind(JSON.stringify(results), eventId)
    .run()
}
