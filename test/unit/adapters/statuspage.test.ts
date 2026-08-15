import { describe, expect, it } from 'vitest'
import statuspage from '../../../src/adapters/statuspage'
import type { Subscription } from '../../../src/types'
import incidentInvestigating from '../../fixtures/statuspage/incident-investigating.json'
import incidentResolved from '../../fixtures/statuspage/incident-resolved.json'
import componentDegraded from '../../fixtures/statuspage/component-degraded.json'
import maintenanceScheduled from '../../fixtures/statuspage/maintenance-scheduled.json'

const sub: Subscription = { name: 'claude-status', source: 'statuspage', enabled: true, sinks: [], auth: null }

const makeReq = (body: unknown) =>
  new Request('https://hooks.example.com/hook/statuspage/abc', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('statuspage adapter', () => {
  it('verify is a no-op (no sender-side auth)', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(incidentInvestigating))
    await expect(statuspage.verify(makeReq(incidentInvestigating), raw, sub, {} as never)).resolves.toBeUndefined()
  })

  it('parses incident.created from investigating status', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(incidentInvestigating))
    const event = await statuspage.parse(makeReq(incidentInvestigating), raw, sub)
    expect(event.source).toBe('statuspage')
    expect(event.subName).toBe('claude-status')
    expect(event.type).toBe('incident.created')
    expect(event.id).toBe('inc-001:upd-001')
    expect(event.severity).toBe('info')
    expect(event.url).toBe('http://stspg.io/abc')
    expect(event.title).toContain('API latency')
    expect(event.body).toContain('investigating elevated latency')
  })

  it('parses incident.resolved and uses the most recent update id', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(incidentResolved))
    const event = await statuspage.parse(makeReq(incidentResolved), raw, sub)
    expect(event.type).toBe('incident.resolved')
    expect(event.id).toBe('inc-001:upd-003')
    expect(event.severity).toBe('info')
  })

  it.each([
    ['scheduled', 'maintenance.scheduled', 'info'],
    ['in_progress', 'maintenance.started', 'warning'],
    ['verifying', 'maintenance.updated', 'info'],
    ['completed', 'maintenance.completed', 'info'],
  ] as const)('maps maintenance status %s to %s', async (status, type, severity) => {
    const payload = {
      ...maintenanceScheduled,
      incident: {
        ...maintenanceScheduled.incident,
        status,
        incident_updates: [
          {
            ...maintenanceScheduled.incident.incident_updates[0],
            id: `maint-upd-${status}`,
            status,
          },
        ],
      },
    }
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    const event = await statuspage.parse(makeReq(payload), raw, sub)
    expect(event.type).toBe(type)
    expect(event.id).toBe(`maint-001:maint-upd-${status}`)
    expect(event.severity).toBe(severity)
    expect(event.title).toContain('Codespaces scheduled maintenance')
    expect(event.body).toContain('scheduled for tomorrow')
    expect(event.url).toBe('http://stspg.io/maintenance')
  })

  it('maps component degraded to component.status_changed with error severity', async () => {
    const raw = new TextEncoder().encode(JSON.stringify(componentDegraded))
    const event = await statuspage.parse(makeReq(componentDegraded), raw, sub)
    expect(event.type).toBe('component.status_changed')
    expect(event.id).toBe('cu-100')
    expect(event.severity).toBe('error')
    expect(event.title).toContain('API')
    expect(event.title).toContain('degraded_performance')
    expect(event.url).toBeUndefined()
  })

  it('maps component major_outage to critical', async () => {
    const payload = {
      ...componentDegraded,
      component_update: { ...componentDegraded.component_update, new_status: 'major_outage' },
      component: { ...componentDegraded.component, status: 'major_outage' },
    }
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    const event = await statuspage.parse(makeReq(payload), raw, sub)
    expect(event.severity).toBe('critical')
  })

  it('throws when incident_updates is empty', async () => {
    const payload = {
      ...incidentInvestigating,
      incident: { ...incidentInvestigating.incident, incident_updates: [] },
    }
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    await expect(statuspage.parse(makeReq(payload), raw, sub)).rejects.toThrow('statuspage incident has no updates')
  })

  it('throws on unknown payload shape', async () => {
    const payload = { meta: {}, page: {} }
    const raw = new TextEncoder().encode(JSON.stringify(payload))
    await expect(statuspage.parse(makeReq(payload), raw, sub)).rejects.toThrow()
  })
})
