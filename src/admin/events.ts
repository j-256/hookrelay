import type { Env } from '../index'
import { verifyAccessJwt } from './access'

interface Filters {
  source?: string
  sub?: string
  type?: string
  since?: '1h' | '24h' | '7d' | '30d'
  page: number
}

const PAGE_SIZE = 50

function parseFilters(url: URL): Filters {
  const since = url.searchParams.get('since')
  const allowedSince = new Set(['1h', '24h', '7d', '30d'])
  return {
    source: url.searchParams.get('source') ?? undefined,
    sub: url.searchParams.get('sub') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
    since: allowedSince.has(since ?? '') ? (since as Filters['since']) : undefined,
    page: Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1),
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
}

async function queryEvents(env: Env, f: Filters): Promise<Row[]> {
  const where: string[] = []
  const binds: unknown[] = []
  if (f.source) {
    where.push('source = ?')
    binds.push(f.source)
  }
  if (f.sub) {
    where.push('sub_name = ?')
    binds.push(f.sub)
  }
  if (f.type) {
    where.push('type = ?')
    binds.push(f.type)
  }
  const sinceIso = sinceToIso(f.since)
  if (sinceIso) {
    where.push('received_at >= ?')
    binds.push(sinceIso)
  }

  const sql =
    'SELECT id, received_at, sub_name, source, type, title, url, severity, fanout_results FROM events' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY received_at DESC LIMIT ? OFFSET ?'
  const offset = (f.page - 1) * PAGE_SIZE
  const stmt = env.EVENTS_DB.prepare(sql).bind(...binds, PAGE_SIZE, offset)
  const result = await stmt.all<Row>()
  return result.results ?? []
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

function renderRow(row: Row): string {
  let fanout: Record<string, { ok: boolean; errMsg?: string }> = {}
  try {
    fanout = JSON.parse(row.fanout_results)
  } catch {}
  const fanoutCells = Object.entries(fanout)
    .map(([sink, r]) =>
      r.ok
        ? `<span class="ok">${escapeHtml(sink)}</span>`
        : `<span class="err" title="${escapeHtml(r.errMsg ?? '')}">${escapeHtml(sink)}</span>`,
    )
    .join(' ')
  const safe = row.url ? safeHref(row.url) : null
  const titleCell = safe
    ? `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapeHtml(row.title)}</a>`
    : escapeHtml(row.title)
  return `<tr>
    <td>${escapeHtml(row.received_at)}</td>
    <td>${escapeHtml(row.id)}</td>
    <td>${escapeHtml(row.source)}</td>
    <td>${escapeHtml(row.sub_name)}</td>
    <td>${escapeHtml(row.type)}</td>
    <td>${escapeHtml(row.severity ?? '')}</td>
    <td>${titleCell}</td>
    <td>${fanoutCells}</td>
    <td><a href="/admin/events/${encodeURIComponent(row.id)}/raw">raw</a></td>
  </tr>`
}

function renderPage(rows: Row[], f: Filters): string {
  const filterValue = (v: string | undefined) => (v ? escapeHtml(v) : '')
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>hookrelay events</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; }
  .ok { color: #1a7f37; }
  .err { color: #b91c1c; cursor: help; text-decoration: underline dotted; }
  form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: end; margin-bottom: 1rem; }
  label { display: flex; flex-direction: column; font-size: 0.8rem; }
  input, select { padding: 0.3rem; }
</style></head><body>
<h1>hookrelay events</h1>
<form>
  <label>source<input name="source" value="${filterValue(f.source)}"></label>
  <label>sub<input name="sub" value="${filterValue(f.sub)}"></label>
  <label>type<input name="type" value="${filterValue(f.type)}"></label>
  <label>since
    <select name="since">
      <option value="">(all)</option>
      ${(['1h', '24h', '7d', '30d'] as const)
        .map((v) => `<option value="${v}"${f.since === v ? ' selected' : ''}>${v}</option>`)
        .join('')}
    </select>
  </label>
  <button type="submit">filter</button>
</form>
<table>
  <thead><tr><th>received_at</th><th>id</th><th>source</th><th>sub</th><th>type</th><th>sev</th><th>title</th><th>sinks</th><th></th></tr></thead>
  <tbody>${rows.map(renderRow).join('')}</tbody>
</table>
${rows.length === PAGE_SIZE ? `<p><a href="?${new URLSearchParams({ ...(f.source ? { source: f.source } : {}), ...(f.sub ? { sub: f.sub } : {}), ...(f.type ? { type: f.type } : {}), ...(f.since ? { since: f.since } : {}), page: String(f.page + 1) }).toString()}">next page</a></p>` : ''}
</body></html>`
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
  const rows = await queryEvents(env, filters)
  return new Response(renderPage(rows, filters), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  })
}
