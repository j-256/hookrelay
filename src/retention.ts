import type { Env } from './index'
import { parseRetentionConfig, RETENTION_CONFIG_KEY } from './lib/runtime-config'
import { recordOperationalSignal, resolveOperationalSignal } from './operations'

export const D1_RETENTION_BATCH_SIZE = 100
export const RETENTION_LAST_RUN_KEY = 'retention:last-run'
export const RETENTION_LAST_SUCCESS_KEY = 'retention:last-success'

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000

export type RetentionMaintenanceResult =
  | { status: 'disabled' | 'skipped'; deleted: 0 }
  | { status: 'succeeded'; deleted: number }
  | { status: 'failed'; deleted: 0 }

async function loadRetentionConfig(env: Env): Promise<ReturnType<typeof parseRetentionConfig>> {
  try {
    return parseRetentionConfig(await env.SUBS.get(RETENTION_CONFIG_KEY))
  } catch {
    return null
  }
}

export async function runD1Retention(
  env: Env,
  now = new Date(),
): Promise<RetentionMaintenanceResult> {
  const retention = await loadRetentionConfig(env)
  if (!retention?.d1Days) return { status: 'disabled', deleted: 0 }

  const timestamp = now.toISOString()
  const dueBefore = new Date(now.getTime() - DAY_MILLISECONDS).toISOString()
  try {
    const claim = await env.EVENTS_DB.prepare(
      `INSERT INTO maintenance_state (key, value, updated_at)
       VALUES (?, 'running', ?)
       ON CONFLICT(key) DO UPDATE SET value = 'running', updated_at = excluded.updated_at
       WHERE maintenance_state.updated_at <= ?`,
    )
      .bind(RETENTION_LAST_RUN_KEY, timestamp, dueBefore)
      .run()
    if (claim.meta.changes === 0) return { status: 'skipped', deleted: 0 }

    const cutoff = new Date(now.getTime() - retention.d1Days * DAY_MILLISECONDS).toISOString()
    const candidates = await env.EVENTS_DB.prepare(
      `SELECT id FROM events WHERE received_at < ? ORDER BY received_at ASC LIMIT ?`,
    )
      .bind(cutoff, D1_RETENTION_BATCH_SIZE)
      .all<{ id: string }>()
    const eventIds = (candidates.results ?? []).map((row) => row.id)
    if (eventIds.length > 0) {
      const placeholders = eventIds.map(() => '?').join(', ')
      await env.EVENTS_DB.prepare(`DELETE FROM events WHERE id IN (${placeholders})`)
        .bind(...eventIds)
        .run()
    }
    const deleted = eventIds.length
    await env.EVENTS_DB.prepare(
      `INSERT INTO maintenance_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(
        RETENTION_LAST_SUCCESS_KEY,
        JSON.stringify({ cutoff, deleted }),
        timestamp,
      )
      .run()
    await resolveOperationalSignal(env, { code: 'retention-prune-rejected' })
    return { status: 'succeeded', deleted }
  } catch {
    await recordOperationalSignal(env, { code: 'retention-prune-rejected' })
    return { status: 'failed', deleted: 0 }
  }
}
