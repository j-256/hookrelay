import type { Env } from '../index'
import { redriveDelivery } from '../delivery'
import type { DeliveryStatus, FanoutResults } from '../types'
import { verifyAccessJwt } from './access'
import { ADMIN_STYLES } from './styles'

const DELIVERY_VIEWS = ['attention', 'active', 'delivered'] as const
type DeliveryView = (typeof DELIVERY_VIEWS)[number]

interface Filters {
  q?: string
  source?: string
  sub?: string
  type?: string
  since?: '1h' | '24h' | '7d' | '30d'
  delivery?: DeliveryView
  page: number
}

const PAGE_SIZE = 50
const MAX_FILTER_LENGTH = 200
const SINCE_VALUES = ['1h', '24h', '7d', '30d'] as const
// Chrome sends Origin: null on form POSTs under no-referrer, breaking the CSRF guard
const ADMIN_REFERRER_POLICY = 'same-origin'

function optionalFilter(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  return value ? value.slice(0, MAX_FILTER_LENGTH) : undefined
}

function parsePage(value: string | null): number {
  if (!value) return 1
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1
}

function parseFilters(url: URL): Filters {
  const since = url.searchParams.get('since')
  const delivery = url.searchParams.get('delivery')
  return {
    q: optionalFilter(url, 'q'),
    source: optionalFilter(url, 'source'),
    sub: optionalFilter(url, 'sub'),
    type: optionalFilter(url, 'type'),
    since: SINCE_VALUES.includes(since as (typeof SINCE_VALUES)[number])
      ? since as Filters['since']
      : undefined,
    delivery: DELIVERY_VIEWS.includes(delivery as DeliveryView)
      ? delivery as DeliveryView
      : undefined,
    page: parsePage(url.searchParams.get('page')),
  }
}

function sinceToIso(s: Filters['since']): string | null {
  if (!s) return null
  const ms = s === '1h' ? 3600e3 : s === '24h' ? 86400e3 : s === '7d' ? 7 * 86400e3 : 30 * 86400e3
  return new Date(Date.now() - ms).toISOString()
}

interface Row {
  id: string
  received_at: string
  sub_name: string
  source: string
  type: string
  title: string
  url: string | null
  severity: string | null
  fanout_results: string
  delivery_results: FanoutResults
}

interface EventRow extends Omit<Row, 'delivery_results'> {}

interface DeliveryRow {
  event_id: string
  sink_name: string
  status: DeliveryStatus
  attempts: number
  last_error: string | null
  updated_at: string
}

interface EventPage {
  rows: Row[]
  total: number
}

function buildEventWhere(f: Filters): { clause: string; binds: unknown[] } {
  const where: string[] = []
  const binds: unknown[] = []
  if (f.q) {
    where.push(`(
      instr(lower(events.id), lower(?)) > 0 OR
      instr(lower(events.title), lower(?)) > 0 OR
      instr(lower(events.type), lower(?)) > 0 OR
      instr(lower(events.source), lower(?)) > 0 OR
      instr(lower(events.sub_name), lower(?)) > 0
    )`)
    binds.push(f.q, f.q, f.q, f.q, f.q)
  }
  if (f.source) {
    where.push('events.source = ?')
    binds.push(f.source)
  }
  if (f.sub) {
    where.push('events.sub_name = ?')
    binds.push(f.sub)
  }
  if (f.type) {
    where.push('events.type = ?')
    binds.push(f.type)
  }
  const sinceIso = sinceToIso(f.since)
  if (sinceIso) {
    where.push('events.received_at >= ?')
    binds.push(sinceIso)
  }
  if (f.delivery === 'attention') {
    where.push(`EXISTS (
      SELECT 1 FROM deliveries delivery_filter
      WHERE delivery_filter.event_id = events.id AND delivery_filter.status = 'exhausted'
    )`)
  } else if (f.delivery === 'active') {
    where.push(`EXISTS (
      SELECT 1 FROM deliveries delivery_filter
      WHERE delivery_filter.event_id = events.id
        AND delivery_filter.status IN ('pending', 'queued', 'processing', 'retrying')
    )`)
  } else if (f.delivery === 'delivered') {
    where.push(`EXISTS (
      SELECT 1 FROM deliveries delivery_filter
      WHERE delivery_filter.event_id = events.id
    )`)
    where.push(`NOT EXISTS (
      SELECT 1 FROM deliveries delivery_filter
      WHERE delivery_filter.event_id = events.id AND delivery_filter.status <> 'delivered'
    )`)
  }
  return {
    clause: where.length ? ' WHERE ' + where.join(' AND ') : '',
    binds,
  }
}

async function queryEvents(env: Env, f: Filters): Promise<EventPage> {
  const { clause, binds } = buildEventWhere(f)
  const countRow = await env.EVENTS_DB.prepare(
    'SELECT COUNT(*) AS total FROM events' + clause,
  )
    .bind(...binds)
    .first<{ total: number }>()

  const sql =
    'SELECT events.id, events.received_at, events.sub_name, events.source, events.type, ' +
    'events.title, events.url, events.severity, events.fanout_results FROM events' +
    clause +
    ' ORDER BY events.received_at DESC LIMIT ? OFFSET ?'
  const offset = (f.page - 1) * PAGE_SIZE
  const stmt = env.EVENTS_DB.prepare(sql).bind(...binds, PAGE_SIZE, offset)
  const result = await stmt.all<EventRow>()
  const rows = result.results ?? []
  if (rows.length === 0) return { rows: [], total: Number(countRow?.total ?? 0) }

  const placeholders = rows.map(() => '?').join(', ')
  const deliveries = await env.EVENTS_DB.prepare(
    `SELECT event_id, sink_name, status, attempts, last_error, updated_at
     FROM deliveries WHERE event_id IN (${placeholders}) ORDER BY sink_name`,
  )
    .bind(...rows.map((row) => row.id))
    .all<DeliveryRow>()
  const byEvent = new Map<string, FanoutResults>()
  for (const delivery of deliveries.results ?? []) {
    const eventResults = byEvent.get(delivery.event_id) ?? {}
    eventResults[delivery.sink_name] = {
      ok: delivery.status === 'delivered',
      status: delivery.status,
      attempts: delivery.attempts,
      ...(delivery.last_error ? { errMsg: delivery.last_error } : {}),
      updatedAt: delivery.updated_at,
    }
    byEvent.set(delivery.event_id, eventResults)
  }
  return {
    rows: rows.map((row) => ({
      ...row,
      delivery_results: byEvent.get(row.id) ?? {},
    })),
    total: Number(countRow?.total ?? 0),
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function safeHref(u: string): string | null {
  try {
    const parsed = new URL(u)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return u
    return null
  } catch {
    return null
  }
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

function formatTimestamp(value: string): { date: string; time: string } {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { date: value, time: '' }
  const date = `${MONTH_NAMES[parsed.getUTCMonth()]} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`
  const time = [parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return { date, time: `${time} UTC` }
}

function eventsHref(f: Filters, overrides: Partial<Filters> = {}): string {
  const merged = { ...f, ...overrides }
  const params = new URLSearchParams()
  if (merged.q) params.set('q', merged.q)
  if (merged.source) params.set('source', merged.source)
  if (merged.sub) params.set('sub', merged.sub)
  if (merged.type) params.set('type', merged.type)
  if (merged.since) params.set('since', merged.since)
  if (merged.delivery) params.set('delivery', merged.delivery)
  if (merged.page > 1) params.set('page', String(merged.page))
  const query = params.toString()
  return `/admin/events${query ? `?${query}` : ''}`
}

function deliveryTone(status: string): 'success' | 'warning' | 'danger' {
  if (status === 'delivered') return 'success'
  if (status === 'exhausted' || status === 'failed') return 'danger'
  return 'warning'
}

function renderDelivery(
  eventId: string,
  sink: string,
  result: FanoutResults[string],
  returnTo: string,
): string {
  const status = result.status ?? (result.ok ? 'delivered' : 'failed')
  const tone = deliveryTone(status)
  const retryable = status === 'exhausted' || status === 'failed'
  const action = `/admin/events/${encodeURIComponent(eventId)}/deliveries/${encodeURIComponent(sink)}/retry?return_to=${encodeURIComponent(returnTo)}`
  const retry = retryable
    ? `<form class="retry" method="post" action="${escapeHtml(action)}"><button class="retry-button" type="submit">Retry</button></form>`
    : ''
  const attempts = result.attempts === undefined ? 'Unknown' : String(result.attempts)
  const updatedAt = result.updatedAt ? escapeHtml(result.updatedAt) : 'Unknown'
  const error = result.errMsg
    ? `<p class="delivery-error">${escapeHtml(result.errMsg)}</p>`
    : ''
  return `<div class="delivery-row">
    <details class="delivery-details"${retryable ? ' open' : ''}>
      <summary class="status-pill status-pill--${tone}">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="delivery-label">${escapeHtml(sink)}: ${escapeHtml(status)}</span>
      </summary>
      <div class="delivery-meta">
        <dl class="delivery-facts">
          <div><dt>Attempts</dt><dd>${escapeHtml(attempts)}</dd></div>
          <div><dt>Updated</dt><dd>${updatedAt}</dd></div>
        </dl>
        ${error}
      </div>
    </details>
    ${retry}
  </div>`
}

function renderRow(row: Row, returnTo: string): string {
  let fanout: FanoutResults = {}
  try {
    const parsed = JSON.parse(row.fanout_results) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      fanout = parsed as FanoutResults
    }
  } catch {}
  fanout = { ...fanout, ...row.delivery_results }
  const fanoutCells = Object.entries(fanout)
    .map(([sink, result]) => renderDelivery(row.id, sink, result, returnTo))
    .join('')
  const safe = row.url ? safeHref(row.url) : null
  const titleCell = safe
    ? `<a class="event-title" href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)} <span aria-hidden="true">&#8599;</span></a>`
    : `<span class="event-title">${escapeHtml(row.title)}</span>`
  const timestamp = formatTimestamp(row.received_at)
  const severityClass = ['info', 'warning', 'error', 'critical'].includes(row.severity ?? '')
    ? ` severity--${row.severity}`
    : ''
  const severity = row.severity
    ? `<span class="severity${severityClass}">${escapeHtml(row.severity)}</span>`
    : '<span class="muted">None</span>'
  return `<tr>
    <td class="received" data-label="Received">
      <time datetime="${escapeHtml(row.received_at)}" title="${escapeHtml(row.received_at)}">
        <span class="received-date">${escapeHtml(timestamp.date)}</span>
        ${timestamp.time ? `<span class="received-time">${escapeHtml(timestamp.time)}</span>` : ''}
      </time>
    </td>
    <td data-label="Event">
      ${titleCell}
      <code class="event-id" title="${escapeHtml(row.id)}">${escapeHtml(row.id)}</code>
    </td>
    <td data-label="Route">
      <div class="route-line">
        <span class="source-badge">${escapeHtml(row.source)}</span>
        <span class="route-arrow" aria-hidden="true">&#8250;</span>
        <span class="subscription">${escapeHtml(row.sub_name)}</span>
      </div>
      <div class="event-type" title="${escapeHtml(row.type)}">${escapeHtml(row.type)}</div>
    </td>
    <td data-label="Severity">${severity}</td>
    <td data-label="Delivery"><div class="delivery-list">${fanoutCells || '<span class="muted">No sinks</span>'}</div></td>
    <td data-label="Payload"><a class="raw-link" href="/admin/events/${encodeURIComponent(row.id)}/raw" target="_blank" rel="noopener noreferrer">View raw <span aria-hidden="true">&#8599;</span></a></td>
  </tr>`
}

function renderQuickView(f: Filters, value: DeliveryView | undefined, label: string): string {
  const isCurrent = f.delivery === value
  return `<a class="quick-view" href="${escapeHtml(eventsHref(f, { delivery: value, page: 1 }))}"${isCurrent ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`
}

function renderEmptyState(hasFilters: boolean): string {
  return `<tr><td class="empty-cell" colspan="6">
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">{ }</div>
      <h3 class="empty-title">${hasFilters ? 'No matching events' : 'No events yet'}</h3>
      <p class="empty-copy">${hasFilters ? 'Try a broader search or reset the filters.' : 'Incoming webhook activity will show up here.'}</p>
      ${hasFilters ? '<p><a class="reset-link" href="/admin/events">Reset all filters</a></p>' : ''}
    </div>
  </td></tr>`
}

function renderPagination(result: EventPage, f: Filters): string {
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const hasPrevious = f.page > 1
  const hasNext = f.page * PAGE_SIZE < result.total
  const previous = hasPrevious
    ? `<a class="page-link" rel="prev" href="${escapeHtml(eventsHref(f, { page: f.page - 1 }))}">&#8592; Previous</a>`
    : ''
  const next = hasNext
    ? `<a class="page-link" rel="next" href="${escapeHtml(eventsHref(f, { page: f.page + 1 }))}">Next &#8594;</a>`
    : ''
  return `<footer class="pagination">
    <span class="pagination-position">Page ${f.page} of ${totalPages}</span>
    <nav class="pagination-links" aria-label="Event pages">${previous}${next}</nav>
  </footer>`
}

function renderPage(result: EventPage, f: Filters): string {
  const filterValue = (v: string | undefined) => (v ? escapeHtml(v) : '')
  const returnTo = eventsHref(f)
  const rangeStart = result.total === 0 ? 0 : (f.page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(f.page * PAGE_SIZE, result.total)
  const activeFilterCount = [f.q, f.source, f.sub, f.type, f.since, f.delivery]
    .filter(Boolean)
    .length
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Events | hookrelay</title>
  <style>${ADMIN_STYLES}</style>
</head>
<body>
  <main class="shell">
    <header class="page-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">H</div>
        <div>
          <p class="eyebrow">hookrelay / admin</p>
          <h1>Event activity</h1>
          <p class="subtitle">Inspect webhook traffic and delivery health.</p>
        </div>
      </div>
      <div class="header-actions">
        <a class="button button-secondary" href="${escapeHtml(returnTo)}"><span aria-hidden="true">&#8635;</span> Refresh</a>
      </div>
    </header>

    <section class="filter-panel" aria-label="Event filters">
      <nav class="quick-views" aria-label="Delivery views">
        ${renderQuickView(f, undefined, 'All events')}
        ${renderQuickView(f, 'attention', 'Needs attention')}
        ${renderQuickView(f, 'active', 'In progress')}
        ${renderQuickView(f, 'delivered', 'Fully delivered')}
      </nav>
      <form class="filters" method="get" action="/admin/events">
        <label class="field field-search">
          <span class="field-label">Search</span>
          <input type="search" name="q" value="${filterValue(f.q)}" placeholder="Title, event ID, type..." maxlength="${MAX_FILTER_LENGTH}" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">Source</span>
          <input name="source" value="${filterValue(f.source)}" placeholder="Any" maxlength="${MAX_FILTER_LENGTH}" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">Subscription</span>
          <input name="sub" value="${filterValue(f.sub)}" placeholder="Any" maxlength="${MAX_FILTER_LENGTH}" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">Event type</span>
          <input name="type" value="${filterValue(f.type)}" placeholder="Any" maxlength="${MAX_FILTER_LENGTH}" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">Received</span>
          <select name="since">
            <option value="">Any time</option>
            <option value="1h"${f.since === '1h' ? ' selected' : ''}>Past hour</option>
            <option value="24h"${f.since === '24h' ? ' selected' : ''}>Past 24 hours</option>
            <option value="7d"${f.since === '7d' ? ' selected' : ''}>Past 7 days</option>
            <option value="30d"${f.since === '30d' ? ' selected' : ''}>Past 30 days</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Delivery</span>
          <select name="delivery">
            <option value="">Any state</option>
            <option value="attention"${f.delivery === 'attention' ? ' selected' : ''}>Needs attention</option>
            <option value="active"${f.delivery === 'active' ? ' selected' : ''}>In progress</option>
            <option value="delivered"${f.delivery === 'delivered' ? ' selected' : ''}>Fully delivered</option>
          </select>
        </label>
        <button class="filter-submit" type="submit">Apply</button>
      </form>
      ${activeFilterCount > 0
        ? `<div class="active-filter-bar"><span>${activeFilterCount} active ${activeFilterCount === 1 ? 'filter' : 'filters'}</span><a class="reset-link" href="/admin/events">Reset all</a></div>`
        : ''}
    </section>

    <section class="table-card" aria-labelledby="events-heading">
      <div class="table-toolbar">
        <h2 class="table-title" id="events-heading">Recent events</h2>
        <p class="result-count">${result.total === 0 ? '<strong>0</strong> events' : `Showing <strong>${rangeStart}-${rangeEnd}</strong> of <strong>${result.total}</strong>`}</p>
      </div>
      <div class="table-scroll">
        <table>
          <caption class="visually-hidden">Webhook events and per-sink delivery states</caption>
          <thead>
            <tr><th scope="col">Received</th><th scope="col">Event</th><th scope="col">Route</th><th scope="col">Severity</th><th scope="col">Delivery</th><th scope="col">Payload</th></tr>
          </thead>
          <tbody>${result.rows.length > 0 ? result.rows.map((row) => renderRow(row, returnTo)).join('') : renderEmptyState(activeFilterCount > 0)}</tbody>
        </table>
      </div>
      ${renderPagination(result, f)}
    </section>
    <p class="page-note">All timestamps are shown in UTC.</p>
  </main>
</body>
</html>`
}

export async function ensureAuthorized(req: Request, env: Env): Promise<boolean> {
  if (env.TEST_BYPASS_ACCESS === '1') return true
  const id = await verifyAccessJwt(req, {
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    audience: env.CF_ACCESS_AUD,
  })
  return id !== null
}

const R2_RETENTION_DAYS = 90

interface RawRow {
  received_at: string
  r2_key: string
}

export async function handleAdminRaw(req: Request, env: Env, eventId: string): Promise<Response> {
  if (!(await ensureAuthorized(req, env))) return new Response('forbidden', { status: 403 })

  const row = await env.EVENTS_DB.prepare(
    'SELECT received_at, r2_key FROM events WHERE id = ?',
  )
    .bind(eventId)
    .first<RawRow>()
  if (!row) return new Response('not found', { status: 404 })

  const obj = await env.EVENTS_RAW.get(row.r2_key)
  if (obj) {
    const headers = new Headers()
    headers.set('content-type', obj.httpMetadata?.contentType ?? 'application/octet-stream')
    headers.set('x-content-type-options', 'nosniff')
    headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    return new Response(obj.body, { status: 200, headers })
  }

  const ageDays = (Date.now() - new Date(row.received_at).getTime()) / 86400e3
  if (ageDays > R2_RETENTION_DAYS) {
    return new Response(
      JSON.stringify({ reason: 'expired', received_at: row.received_at }),
      { status: 410, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response(JSON.stringify({ reason: 'missing' }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  })
}

export async function handleAdminEvents(req: Request, env: Env): Promise<Response> {
  if (!(await ensureAuthorized(req, env))) return new Response('forbidden', { status: 403 })
  const url = new URL(req.url)
  const filters = parseFilters(url)
  const result = await queryEvents(env, filters)
  return new Response(renderPage(result, filters), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': ADMIN_REFERRER_POLICY,
    },
  })
}

function retryReturnLocation(url: URL): string {
  const candidate = url.searchParams.get('return_to')
  if (!candidate) return '/admin/events'
  try {
    const parsed = new URL(candidate, url.origin)
    if (parsed.origin !== url.origin || parsed.pathname !== '/admin/events') {
      return '/admin/events'
    }
    return parsed.pathname + parsed.search
  } catch {
    return '/admin/events'
  }
}

export async function handleAdminRetry(
  req: Request,
  env: Env,
  eventId: string,
  sinkName: string,
): Promise<Response> {
  if (!(await ensureAuthorized(req, env))) return new Response('forbidden', { status: 403 })
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  }
  const url = new URL(req.url)
  const origin = req.headers.get('origin')
  if (origin !== url.origin) return new Response('forbidden', { status: 403 })

  const result = await redriveDelivery(env, eventId, sinkName)
  if (!result.ok) {
    const status = result.reason?.includes('not found') ? 404 : 409
    return new Response(result.reason ?? 'retry rejected', { status })
  }
  return new Response(null, { status: 303, headers: { location: retryReturnLocation(url) } })
}
