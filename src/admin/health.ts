import type { Env } from '../index'
import {
  OPERATIONS_CONFIG_KEY,
  parseOperationsConfig,
  parseRetentionConfig,
  RETENTION_CONFIG_KEY,
} from '../lib/runtime-config'
import { adminHtmlResponse, ensureAuthorized, escapeHtml } from './events'
import { ADMIN_STYLES } from './styles'

interface DeliveryTotalRow {
  state: string
  total: number
}

interface SignalRow {
  code: string
  severity: string
  source: string | null
  sub_name: string | null
  event_id: string | null
  sink_name: string | null
  summary: string
  first_seen_at: string
  last_seen_at: string
  occurrences: number
  resolved_at: string | null
}

interface AlertRow {
  code: string
  sink_name: string
  alerted_occurrences: number
  attempts: number
  last_attempt_at: string | null
  next_attempt_at: string | null
  last_error: string | null
  delivered_at: string | null
}

interface LastEventRow {
  sub_name: string
  source: string
  last_received_at: string
}

interface LastDeliveryRow {
  sink_name: string
  last_delivered_at: string
}

function optionalCell(value: string | null): string {
  return value ? escapeHtml(value) : '<span class="muted">None</span>'
}

function ageLabel(value: string | null): string {
  if (!value) return 'None'
  const milliseconds = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(milliseconds)) return value
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function renderSignals(rows: SignalRow[]): string {
  if (rows.length === 0) {
    return '<tr><td class="empty-cell" colspan="6">No operational signals recorded.</td></tr>'
  }
  return rows.map((row) => `<tr>
    <td data-label="Signal"><strong>${escapeHtml(row.summary)}</strong><code class="event-id">${escapeHtml(row.code)}</code></td>
    <td data-label="Severity"><span class="severity severity--${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></td>
    <td data-label="Route">${optionalCell(row.source)} / ${optionalCell(row.sub_name)}</td>
    <td data-label="Delivery">${optionalCell(row.event_id)} / ${optionalCell(row.sink_name)}</td>
    <td data-label="Occurrences">${row.occurrences}<br><span class="muted">Last: ${escapeHtml(row.last_seen_at)}</span></td>
    <td data-label="State">${row.resolved_at ? `Resolved ${escapeHtml(row.resolved_at)}` : '<span class="status-pill status-pill--danger"><span class="status-dot"></span>Open</span>'}</td>
  </tr>`).join('')
}

function renderAlerts(rows: AlertRow[]): string {
  if (rows.length === 0) {
    return '<tr><td class="empty-cell" colspan="5">No operations alerts attempted.</td></tr>'
  }
  return rows.map((row) => `<tr>
    <td data-label="Signal"><code>${escapeHtml(row.code)}</code></td>
    <td data-label="Sink">${escapeHtml(row.sink_name)}</td>
    <td data-label="Attempts">${row.attempts} (${row.alerted_occurrences} occurrences alerted)</td>
    <td data-label="Last attempt">${optionalCell(row.last_attempt_at)}</td>
    <td data-label="State">${row.last_error ? escapeHtml(row.last_error) : row.delivered_at ? `Delivered ${escapeHtml(row.delivered_at)}` : `Due ${optionalCell(row.next_attempt_at)}`}</td>
  </tr>`).join('')
}

export async function handleAdminHealth(req: Request, env: Env): Promise<Response> {
  if (!(await ensureAuthorized(req, env))) return new Response('forbidden', { status: 403 })
  if (req.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
  }

  const [
    totalsResult,
    oldestActive,
    openSignalResult,
    signalsResult,
    alertsResult,
    eventsResult,
    deliveriesResult,
    maintenanceResult,
    operationsRaw,
    retentionRaw,
  ] = await Promise.all([
    env.EVENTS_DB.prepare(
      `SELECT CASE
         WHEN status IN ('pending', 'queued', 'processing', 'retrying') THEN 'active'
         ELSE status
       END AS state, COUNT(*) AS total
       FROM deliveries GROUP BY state`,
    ).all<DeliveryTotalRow>(),
    env.EVENTS_DB.prepare(
      `SELECT MIN(updated_at) AS oldest
       FROM deliveries WHERE status IN ('pending', 'queued', 'processing', 'retrying')`,
    ).first<{ oldest: string | null }>(),
    env.EVENTS_DB.prepare(
      'SELECT COUNT(*) AS total FROM operational_signals WHERE resolved_at IS NULL',
    ).first<{ total: number }>(),
    env.EVENTS_DB.prepare(
      `SELECT code, severity, source, sub_name, event_id, sink_name, summary,
              first_seen_at, last_seen_at, occurrences, resolved_at
       FROM operational_signals ORDER BY last_seen_at DESC LIMIT 50`,
    ).all<SignalRow>(),
    env.EVENTS_DB.prepare(
      `SELECT operational_signals.code, operational_alert_deliveries.sink_name,
              operational_alert_deliveries.alerted_occurrences,
              operational_alert_deliveries.attempts,
              operational_alert_deliveries.last_attempt_at,
              operational_alert_deliveries.next_attempt_at,
              operational_alert_deliveries.last_error,
              operational_alert_deliveries.delivered_at
       FROM operational_alert_deliveries
       JOIN operational_signals USING (fingerprint)
       ORDER BY operational_alert_deliveries.last_attempt_at DESC LIMIT 50`,
    ).all<AlertRow>(),
    env.EVENTS_DB.prepare(
      `SELECT sub_name, source, MAX(received_at) AS last_received_at
       FROM events GROUP BY sub_name, source ORDER BY sub_name`,
    ).all<LastEventRow>(),
    env.EVENTS_DB.prepare(
      `SELECT sink_name, MAX(delivered_at) AS last_delivered_at
       FROM deliveries WHERE status = 'delivered'
       GROUP BY sink_name ORDER BY sink_name`,
    ).all<LastDeliveryRow>(),
    env.EVENTS_DB.prepare(
      `SELECT updated_at FROM maintenance_state WHERE key = 'retention:last-success'`,
    ).first<{ updated_at: string }>(),
    env.SUBS.get(OPERATIONS_CONFIG_KEY),
    env.SUBS.get(RETENTION_CONFIG_KEY),
  ])

  const totals = new Map((totalsResult.results ?? []).map((row) => [row.state, row.total]))
  const operations = parseOperationsConfig(operationsRaw)
  const retention = parseRetentionConfig(retentionRaw)
  const signalRows = signalsResult.results ?? []
  const openSignals = Number(openSignalResult?.total ?? 0)
  const eventRows = eventsResult.results ?? []
  const deliveryRows = deliveriesResult.results ?? []
  const retentionDescription = retention
    ? [
        retention.r2Days ? `R2 raw payloads: ${retention.r2Days} days` : 'R2 raw payloads: unmanaged',
        retention.d1Days ? `D1 events: ${retention.d1Days} days` : 'D1 events: unmanaged',
      ].join(' / ')
    : 'Retention is not configured'

  return adminHtmlResponse(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Health | hookrelay</title>
  <style>${ADMIN_STYLES}</style>
</head>
<body>
  <main class="shell">
    <header class="page-header">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">H</div>
        <div><p class="eyebrow">hookrelay / admin</p><h1>Operational health</h1><p class="subtitle">Delivery state, redacted failures, alerting, and retention.</p></div>
      </div>
      <div class="header-actions"><a class="button button-secondary" href="/admin/events">Events</a><a class="button button-secondary" href="/admin/health"><span aria-hidden="true">&#8635;</span> Refresh</a></div>
    </header>

    <section class="health-grid" aria-label="Delivery totals">
      <article class="metric-card"><span>Active</span><strong>${totals.get('active') ?? 0}</strong><small>Oldest: ${escapeHtml(ageLabel(oldestActive?.oldest ?? null))}</small></article>
      <article class="metric-card"><span>Exhausted</span><strong>${totals.get('exhausted') ?? 0}</strong><small>Needs attention</small></article>
      <article class="metric-card"><span>Delivered</span><strong>${totals.get('delivered') ?? 0}</strong><small>Successful sinks</small></article>
      <article class="metric-card"><span>Filtered</span><strong>${totals.get('filtered') ?? 0}</strong><small>Policy decisions</small></article>
      <article class="metric-card"><span>Open signals</span><strong>${openSignals}</strong><small>${operations ? `${operations.sinks.length} alert sinks` : 'Alerting not configured'}</small></article>
    </section>

    <section class="table-card health-section">
      <div class="table-toolbar"><h2 class="table-title">Operational signals</h2><p class="result-count">Fixed-code, redacted diagnostics</p></div>
      <div class="table-scroll"><table><thead><tr><th>Signal</th><th>Severity</th><th>Route</th><th>Delivery</th><th>Occurrences</th><th>State</th></tr></thead><tbody>${renderSignals(signalRows)}</tbody></table></div>
    </section>

    <section class="table-card health-section">
      <div class="table-toolbar"><h2 class="table-title">Operations alerts</h2><p class="result-count">Direct dispatch with cooldown</p></div>
      <div class="table-scroll"><table><thead><tr><th>Signal</th><th>Sink</th><th>Attempts</th><th>Last attempt</th><th>State</th></tr></thead><tbody>${renderAlerts(alertsResult.results ?? [])}</tbody></table></div>
    </section>

    <div class="health-split">
      <section class="table-card health-section">
        <div class="table-toolbar"><h2 class="table-title">Last accepted event</h2><p class="result-count">Per subscription</p></div>
        <div class="table-scroll"><table><thead><tr><th>Subscription</th><th>Source</th><th>Received</th></tr></thead><tbody>${eventRows.length ? eventRows.map((row) => `<tr><td>${escapeHtml(row.sub_name)}</td><td>${escapeHtml(row.source)}</td><td>${escapeHtml(row.last_received_at)}</td></tr>`).join('') : '<tr><td class="empty-cell" colspan="3">No events accepted.</td></tr>'}</tbody></table></div>
      </section>
      <section class="table-card health-section">
        <div class="table-toolbar"><h2 class="table-title">Last successful delivery</h2><p class="result-count">Per sink</p></div>
        <div class="table-scroll"><table><thead><tr><th>Sink</th><th>Delivered</th></tr></thead><tbody>${deliveryRows.length ? deliveryRows.map((row) => `<tr><td>${escapeHtml(row.sink_name)}</td><td>${escapeHtml(row.last_delivered_at)}</td></tr>`).join('') : '<tr><td class="empty-cell" colspan="2">No successful deliveries.</td></tr>'}</tbody></table></div>
      </section>
    </div>

    <section class="config-card">
      <h2>Retention</h2><p>${escapeHtml(retentionDescription)}</p><p>Last D1 prune: ${maintenanceResult ? escapeHtml(maintenanceResult.updated_at) : 'Never'}</p>
    </section>
  </main>
</body>
</html>`)
}
