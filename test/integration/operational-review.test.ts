import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker, { type Env } from '../../src/index'
import { configurationQuery } from '../../src/configuration/authority'
import { applyOperationalResolution, planOperationalResolution, readOperationalResolution, readOperationalSignals, RESOLUTION_LIMITS } from '../../src/operational-review'
import { managementTokenHash } from '../../src/management/access'
import { recordOperationalSignal } from '../../src/operations'
import { redriveDelivery } from '../../src/delivery'

const owner = { clientId: 'operator', clientRevision: 1, workspaceId: 'workspace', actorId: 'actor' }
const query = configurationQuery(env.EVENTS_DB)
const timestamp = '2026-01-01T00:00:00.000Z'
const runtime = env as unknown as Env
const signal = { code: 'ingress-persistence-rejected' as const, source: 'github', subName: 'fixture', eventId: 'github:fixture' }

beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM operational_resolution_reviews; DELETE FROM operational_alert_deliveries; DELETE FROM operational_signals; DELETE FROM deliveries; DELETE FROM events;')
  await recordOperationalSignal(runtime, signal)
  await env.EVENTS_DB.prepare(`INSERT INTO events (id,received_at,sub_slug,sub_name,source,type,title,r2_key)
    VALUES ('github:fixture',?,'synthetic','fixture','github','fixture','PRIVATE_PAYLOAD','PRIVATE_KEY')`).bind(timestamp).run()
  await env.EVENTS_DB.prepare(`INSERT INTO deliveries (event_id,sink_name,generation,status,attempts,created_at,updated_at)
    VALUES ('github:fixture','phone',2,'exhausted',0,?,?)`).bind(timestamp, timestamp).run()
})

async function input() {
  const row = (await readOperationalSignals(query, {})).items[0]!
  return { planId: crypto.randomUUID(), reason: 'accepted-loss' as const, note: 'Historical notification was not verified', targets: [
    { kind: 'signal' as const, fingerprint: row.fingerprint, lastSeenAt: row.lastSeenAt, occurrences: row.occurrences },
    { kind: 'delivery' as const, eventId: 'github:fixture', sinkName: 'phone', generation: 2, updatedAt: timestamp },
  ] }
}

describe('reviewed operational disposition', () => {
  it('preserves failed delivery state and history, audits the disposition, and replays without effects', async () => {
    const fields = await input()
    const plan = await planOperationalResolution(query, owner, fields)
    expect(plan.state).toBe('review')
    expect((await readOperationalSignals(query, {})).items).toHaveLength(1)
    const accepted = await applyOperationalResolution(query, owner, plan.planId)
    expect(accepted.state).toBe('accepted')
    expect(await applyOperationalResolution(query, owner, plan.planId)).toEqual(accepted)
    expect(await readOperationalResolution(query, owner, plan.planId)).toEqual(accepted)
    expect((await readOperationalSignals(query, {})).items).toHaveLength(0)
    expect((await readOperationalSignals(query, { resolved: true })).items[0]?.resolutionReason).toBe('accepted-loss')
    expect(await env.EVENTS_DB.prepare('SELECT status,generation,attempts,resolved_at,resolution_reason FROM deliveries').first())
      .toEqual({ status: 'exhausted', generation: 3, attempts: 0, resolved_at: accepted.acceptedAt, resolution_reason: 'accepted-loss' })
    expect(await env.EVENTS_DB.prepare('SELECT count(*) AS total FROM events').first()).toEqual({ total: 1 })
    expect(JSON.stringify(accepted)).not.toContain('PRIVATE')
    expect((await redriveDelivery(runtime, 'github:fixture', 'phone')).ok).toBe(false)
  })

  it('rejects recurrence atomically and reopens a resolved signal on new failure', async () => {
    const first = await planOperationalResolution(query, owner, await input())
    await recordOperationalSignal(runtime, signal)
    await expect(applyOperationalResolution(query, owner, first.planId)).rejects.toMatchObject({ code: 'conflict' })
    expect(await env.EVENTS_DB.prepare('SELECT resolved_at FROM deliveries').first()).toEqual({ resolved_at: null })
    const second = await planOperationalResolution(query, owner, await input())
    await applyOperationalResolution(query, owner, second.planId)
    await recordOperationalSignal(runtime, signal)
    const reopened = (await readOperationalSignals(query, {})).items[0]!
    expect(reopened.occurrences).toBe(3)
    expect(reopened.resolutionReason).toBeNull()
    expect((await applyOperationalResolution(query, owner, second.planId)).state).toBe('accepted')
    expect((await readOperationalSignals(query, {})).items).toHaveLength(1)
  })

  it('rejects changed delivery generations, stale state, changed inputs, expiry, and different owner identities', async () => {
    const fields = await input()
    const plan = await planOperationalResolution(query, owner, fields)
    await expect(planOperationalResolution(query, owner, { ...fields, note: 'Changed' })).rejects.toMatchObject({ code: 'conflict' })
    for (const changed of [{ actorId: 'other' }, { workspaceId: 'other' }, { clientId: 'other' }, { clientRevision: 2 }]) {
      await expect(applyOperationalResolution(query, { ...owner, ...changed }, plan.planId)).rejects.toMatchObject({ code: 'not_found' })
    }
    await env.EVENTS_DB.prepare('UPDATE deliveries SET generation=3').run()
    await expect(applyOperationalResolution(query, owner, plan.planId)).rejects.toMatchObject({ code: 'conflict' })
    expect((await readOperationalSignals(query, {})).items).toHaveLength(1)
    await env.EVENTS_DB.prepare('UPDATE operational_resolution_reviews SET expires_at=?').bind(timestamp).run()
    await expect(applyOperationalResolution(query, owner, plan.planId)).rejects.toMatchObject({ code: 'expired' })
  })

  it('allows only one competing exact-state review to apply', async () => {
    const fields = await input()
    const first = await planOperationalResolution(query, owner, fields)
    const second = await planOperationalResolution(query, owner, { ...fields, planId: crypto.randomUUID() })
    const outcomes = await Promise.allSettled([first, second].map(plan => applyOperationalResolution(query, owner, plan.planId)))
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  })

  it('bounds reviews and paginates signals with identical timestamps without leaking payloads', async () => {
    for (let index = 0; index < RESOLUTION_LIMITS.PAGE_SIZE; index += 1) {
      await recordOperationalSignal(runtime, { ...signal, eventId: `github:fixture-${index}` })
    }
    await env.EVENTS_DB.prepare('UPDATE operational_signals SET last_seen_at=?').bind(timestamp).run()
    const first = await readOperationalSignals(query, {})
    const second = await readOperationalSignals(query, { cursor: first.nextCursor })
    expect(first.items).toHaveLength(RESOLUTION_LIMITS.PAGE_SIZE)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(row => row.fingerprint)).size).toBe(RESOLUTION_LIMITS.PAGE_SIZE + 1)
    expect(JSON.stringify(first)).not.toContain('PRIVATE')
    const fields = await input()
    await expect(planOperationalResolution(query, owner, { ...fields, targets: [fields.targets[0], fields.targets[0]] })).rejects.toThrow()
    for (let index = 0; index < RESOLUTION_LIMITS.PENDING; index += 1) {
      await planOperationalResolution(query, owner, { ...fields, planId: crypto.randomUUID() })
    }
    await expect(planOperationalResolution(query, owner, { ...fields, planId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('requires the separate resolution grant, preserves read access, and rejects cross-workspace requests', async () => {
    const token = `hkr_${'a'.repeat(43)}`
    const credential = { id: 'operator', revision: 1, tokenHash: await managementTokenHash(token), expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceIds: ['workspace'], capabilities: ['read', 'retry', 'configure'] }
    const target = new Proxy(runtime, { get(value, property, receiver) {
      return property === 'MANAGEMENT_CREDENTIALS' ? JSON.stringify([credential]) : Reflect.get(value, property, receiver)
    } })
    const call = (command: string, fields: object) => worker.fetch(new Request('https://fixture.example/admin/api/v1', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command, input: { workspaceId: owner.workspaceId, actorId: owner.actorId, ...fields } }),
    }), target, {} as ExecutionContext)
    expect((await call('signals', {})).status).toBe(200)
    expect((await call('signals', { workspaceId: 'other' })).status).toBe(404)
    const fields = await input()
    expect((await call('resolution_plan', fields)).status).toBe(403)
    credential.capabilities.push('resolve')
    expect((await call('resolution_plan', fields)).status).toBe(200)
    expect((await call('resolution_apply', { planId: fields.planId })).status).toBe(200)
    expect((await call('deliveries', { status: 'exhausted' })).status).toBe(200)
    const open = await call('deliveries', { status: 'exhausted' })
    expect(await open.json()).toMatchObject({ result: { items: [] } })
    const history = await call('delivery', { eventId: 'github:fixture', sinkName: 'phone' })
    expect(await history.json()).toMatchObject({ result: { status: 'exhausted', resolutionReason: 'accepted-loss' } })
  })
})
