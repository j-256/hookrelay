import type { Adapter } from '.'
import type { NormalizedEvent, Severity, Subscription } from '../types'

function assertNever(x: never): never {
  throw new Error(`unrecognized incident status: ${String(x)}`)
}

interface IncidentUpdate {
  id: string
  status: string
  body: string
  created_at: string
}

interface IncidentPayload {
  incident: {
    id: string
    name: string
    status: IncidentStatus
    impact: string
    shortlink?: string
    created_at: string
    updated_at: string
    incident_updates: IncidentUpdate[]
  }
}

type IncidentStatus =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'postmortem'
  | 'scheduled'
  | 'in_progress'
  | 'verifying'
  | 'completed'

interface ComponentPayload {
  component_update: {
    id: string
    created_at: string
    new_status: string
    old_status: string
    component_id: string
  }
  component: {
    id: string
    name: string
    status: string
  }
}

const COMPONENT_SEVERITY: Record<string, Severity> = {
  operational: 'info',
  under_maintenance: 'info',
  degraded_performance: 'error',
  partial_outage: 'error',
  major_outage: 'critical',
}

function isIncident(p: unknown): p is IncidentPayload {
  if (typeof p !== 'object' || p === null) return false
  const obj = p as Record<string, unknown>
  return typeof obj.incident === 'object' && obj.incident !== null
}

function isComponent(p: unknown): p is ComponentPayload {
  if (typeof p !== 'object' || p === null) return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.component_update === 'object' && obj.component_update !== null &&
    typeof obj.component === 'object' && obj.component !== null
  )
}

function incidentType(status: IncidentPayload['incident']['status']): string {
  switch (status) {
    case 'investigating':
      return 'incident.created'
    case 'identified':
    case 'monitoring':
    case 'postmortem':
      return 'incident.updated'
    case 'resolved':
      return 'incident.resolved'
    case 'scheduled':
      return 'maintenance.scheduled'
    case 'in_progress':
      return 'maintenance.started'
    case 'verifying':
      return 'maintenance.updated'
    case 'completed':
      return 'maintenance.completed'
    default:
      return assertNever(status)
  }
}

function incidentSeverity(p: IncidentPayload): Severity {
  if (
    p.incident.status === 'resolved' ||
    p.incident.status === 'scheduled' ||
    p.incident.status === 'verifying' ||
    p.incident.status === 'completed'
  ) return 'info'
  if (p.incident.status === 'in_progress') return 'warning'
  switch (p.incident.impact) {
    case 'none':
    case 'minor':
      return 'info'
    case 'major':
      return 'warning'
    case 'critical':
      return 'critical'
    default:
      return 'info'
  }
}

const adapter: Adapter = {
  sourceType: 'statuspage',

  async verify(_req, _raw, _sub, _env) {
    /* no sender-side auth -- the slug is the gate */
  },

  async parse(_req, raw, sub: Subscription): Promise<NormalizedEvent> {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as unknown

    if (isIncident(payload)) {
      const inc = payload.incident
      const latest = inc.incident_updates[0]
      if (!latest) throw new Error('statuspage incident has no updates')
      return {
        source: 'statuspage',
        subName: sub.name,
        type: incidentType(inc.status),
        id: `${inc.id}:${latest.id}`,
        timestamp: latest.created_at,
        title: `[${inc.status}] ${inc.name}`,
        body: latest.body,
        url: inc.shortlink,
        severity: incidentSeverity(payload),
        raw: payload,
      }
    }

    if (isComponent(payload)) {
      const cu = payload.component_update
      const c = payload.component
      return {
        source: 'statuspage',
        subName: sub.name,
        type: 'component.status_changed',
        id: cu.id,
        timestamp: cu.created_at,
        title: `${c.name} -> ${cu.new_status}`,
        body: `${c.name} changed from ${cu.old_status} to ${cu.new_status}`,
        severity: COMPONENT_SEVERITY[cu.new_status] ?? 'info',
        raw: payload,
      }
    }

    throw new Error('unrecognized statuspage payload shape')
  },
}

export default adapter
