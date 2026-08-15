import { redriveDelivery } from '../delivery'
import type { Env } from '../index'
import {
  adminHtmlResponse,
  buildEventWhere,
  ensureAuthorized,
  escapeHtml,
  eventsHref,
  parseFilters,
  type Filters,
} from './events'
import { ADMIN_STYLES } from './styles'

export const MAX_BULK_RETRY_DELIVERIES = 100

interface RetryRow {
  event_id: string
  sink_name: string
}

function exhaustedWhere(filters: Filters): { clause: string; binds: unknown[] } {
  const eventWhere = buildEventWhere(filters)
  return {
    clause: eventWhere.clause + (eventWhere.clause ? ' AND ' : ' WHERE ') +
      "deliveries.status = 'exhausted'",
    binds: eventWhere.binds,
  }
}

async function exhaustedCount(env: Env, filters: Filters): Promise<number> {
  const { clause, binds } = exhaustedWhere(filters)
  const row = await env.EVENTS_DB.prepare(
    'SELECT COUNT(*) AS total FROM deliveries JOIN events ON events.id = deliveries.event_id' + clause,
  )
    .bind(...binds)
    .first<{ total: number }>()
  return Number(row?.total ?? 0)
}

async function exhaustedRows(env: Env, filters: Filters): Promise<RetryRow[]> {
  const { clause, binds } = exhaustedWhere(filters)
  const result = await env.EVENTS_DB.prepare(
    `SELECT deliveries.event_id, deliveries.sink_name
     FROM deliveries JOIN events ON events.id = deliveries.event_id${clause}
     ORDER BY events.received_at ASC, deliveries.event_id, deliveries.sink_name LIMIT ?`,
  )
    .bind(...binds, MAX_BULK_RETRY_DELIVERIES)
    .all<RetryRow>()
  return result.results ?? []
}

function pageShell(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} | hookrelay</title><style>${ADMIN_STYLES}</style></head>
<body><main class="shell"><header class="page-header"><div class="brand"><div class="brand-mark" aria-hidden="true">H</div><div><p class="eyebrow">hookrelay / admin</p><h1>${escapeHtml(title)}</h1><p class="subtitle">Redrive exhausted deliveries without escaping the selected filters.</p></div></div></header>${content}</main></body>
</html>`
}

export async function handleAdminBulkRetry(req: Request, env: Env): Promise<Response> {
  if (!(await ensureAuthorized(req, env))) return new Response('forbidden', { status: 403 })
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } })
  }
  const url = new URL(req.url)
  const filters = parseFilters(url)
  if (filters.delivery !== 'attention') {
    return new Response('bulk retry requires the Needs attention delivery filter', { status: 400 })
  }
  const returnTo = eventsHref(filters)
  if (req.method === 'GET') {
    const total = await exhaustedCount(env, filters)
    return adminHtmlResponse(pageShell('Retry matching deliveries', `
      <section class="confirm-card">
        <h2>Confirm bulk retry</h2>
        <p><strong>${total}</strong> exhausted ${total === 1 ? 'delivery matches' : 'deliveries match'} the selected filters.</p>
        <p>At most <strong>${MAX_BULK_RETRY_DELIVERIES}</strong> deliveries will be retried. The selection is checked again when you confirm.</p>
        <div class="header-actions"><form method="post"><button class="filter-submit" type="submit">Retry matching deliveries</button></form><a class="button button-secondary" href="${escapeHtml(returnTo)}">Cancel</a></div>
      </section>`))
  }

  if (req.headers.get('origin') !== url.origin) {
    return new Response('forbidden', { status: 403 })
  }
  const total = await exhaustedCount(env, filters)
  const rows = await exhaustedRows(env, filters)
  let succeeded = 0
  let skipped = 0
  for (const row of rows) {
    const result = await redriveDelivery(env, row.event_id, row.sink_name)
    if (result.ok) succeeded += 1
    else skipped += 1
  }
  const capped = Math.max(0, total - rows.length)
  return adminHtmlResponse(pageShell('Bulk retry result', `
    <section class="confirm-card">
      <h2>Retry request completed</h2>
      <dl class="result-list"><div><dt>Succeeded</dt><dd>${succeeded}</dd></div><div><dt>Skipped</dt><dd>${skipped}</dd></div><div><dt>Capped</dt><dd>${capped}</dd></div></dl>
      <p>Skipped deliveries changed state before redrive. Capped deliveries remain exhausted and can be retried in another confirmed batch.</p>
      <a class="button button-secondary" href="${escapeHtml(returnTo)}">Return to events</a>
    </section>`))
}
