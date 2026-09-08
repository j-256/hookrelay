import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONFIGURATION_LIMITS } from '../../src/configuration/authority'

const PRIVATE = 'synthetic-private-configuration'
const SUBSCRIPTION_KEY = `sub:sha256:${'b'.repeat(64)}`
const RESOURCE = '00000000-0000-4000-8000-000000000001'
const CAS = `UPDATE configuration_authority
  SET revision = revision + 1, mode = 'active', operation_id = ?, pending_change = ?
  WHERE singleton = 1 AND authority_id = ? AND revision = ?
  RETURNING authority_id, revision, mode, operation_id`
let authorityId: string

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM configuration_entries; DELETE FROM configuration_receipts; UPDATE configuration_authority SET revision = 0, mode = \'legacy\', operation_id = NULL, pending_change = NULL;')
  authorityId = (await env.EVENTS_DB.prepare('SELECT authority_id FROM configuration_authority').first<{ authority_id: string }>())!.authority_id
})

function change(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'operator', clientRevision: 1, workspaceId: 'provider', actorId: 'owner',
    kind: 'migration', inputHash: 'a'.repeat(64),
    puts: [{ namespace: 'SUBS', key: SUBSCRIPTION_KEY, resourceId: RESOURCE, value: JSON.stringify({ name: PRIVATE }) }],
    deletes: [], ...overrides,
  }
}

function accept(revision = 0, payload = change(), operationId = crypto.randomUUID()) {
  return env.EVENTS_DB.prepare(CAS).bind(operationId, JSON.stringify(payload), authorityId, revision).all()
}

describe('configuration acceptance in isolated D1', () => {
  it('atomically indexes entries and records acceptance without retaining the private change payload', async () => {
    const result = await accept()
    expect(result.results).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
    const state = await env.EVENTS_DB.prepare('SELECT * FROM configuration_authority').first()
    expect(state).toMatchObject({ revision: 1, mode: 'active', pending_change: null })
    const entry = await env.EVENTS_DB.prepare('SELECT * FROM configuration_entries').first()
    expect(entry).toMatchObject({ resource_id: RESOURCE, value: JSON.stringify({ name: PRIVATE }) })
    const receipts = await env.EVENTS_DB.prepare('SELECT * FROM configuration_receipts').all()
    expect(receipts.results).toHaveLength(1)
    expect(receipts.results[0]).toMatchObject({ revision: 1, before_revision: 0 })
    expect(JSON.stringify(receipts)).not.toContain(PRIVATE)
  })

  it('accepts only one concurrent writer for a captured revision', async () => {
    const outcomes = await Promise.all([accept(), accept(), accept()])
    expect(outcomes.reduce((sum, result) => sum + result.results.length, 0)).toBe(1)
    expect((await env.EVENTS_DB.prepare('SELECT revision FROM configuration_authority').first())?.revision).toBe(1)
  })

  it('rejects invalid revision, identity and mode transitions before changing entries', async () => {
    const statement = `UPDATE configuration_authority
      SET authority_id = ?, revision = ?, mode = ?, operation_id = ?, pending_change = ?
      WHERE singleton = 1`
    for (const transition of [
      { authority: authorityId, revision: 2, mode: 'active' },
      { authority: 'f'.repeat(32), revision: 1, mode: 'active' },
      { authority: authorityId, revision: 1, mode: 'legacy' },
    ]) {
      await expect(env.EVENTS_DB.prepare(statement).bind(
        transition.authority, transition.revision, transition.mode, crypto.randomUUID(), JSON.stringify(change()),
      ).all()).rejects.toThrow()
    }
    expect(await env.EVENTS_DB.prepare('SELECT authority_id, revision, mode, pending_change FROM configuration_authority').first())
      .toEqual({ authority_id: authorityId, revision: 0, mode: 'legacy', pending_change: null })
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_entries').first())?.count).toBe(0)
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_receipts').first())?.count).toBe(0)
  })

  it('rolls back entries, state and receipts together when an entry violates a constraint', async () => {
    await accept()
    await expect(accept(1, change({
      deletes: [{ namespace: 'SUBS', key: SUBSCRIPTION_KEY }],
      puts: [{ namespace: 'OTHER', key: 'invalid', resourceId: RESOURCE, value: '{}' }],
    }))).rejects.toThrow()
    expect((await env.EVENTS_DB.prepare('SELECT value FROM configuration_entries').first())?.value).toBe(JSON.stringify({ name: PRIVATE }))
    expect((await env.EVENTS_DB.prepare('SELECT revision FROM configuration_authority').first())?.revision).toBe(1)
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_receipts').first())?.count).toBe(1)
  })

  it('rejects reused operation IDs without replaying entry effects', async () => {
    const id = crypto.randomUUID()
    await accept(0, change(), id)
    await expect(accept(1, change({ puts: [], deletes: [{ namespace: 'SUBS', key: SUBSCRIPTION_KEY }] }), id)).rejects.toThrow()
    expect((await env.EVENTS_DB.prepare('SELECT revision FROM configuration_authority').first())?.revision).toBe(1)
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_entries').first())?.count).toBe(1)
  })

  it('uses the composite index for exact runtime configuration lookups', async () => {
    const query = await env.EVENTS_DB.prepare(
      'EXPLAIN QUERY PLAN SELECT value FROM configuration_entries WHERE namespace = ? AND entry_key = ?',
    ).bind('SUBS', SUBSCRIPTION_KEY).all<{ detail: string }>()
    expect(query.results.some(row => row.detail.includes('SEARCH') && row.detail.includes('INDEX'))).toBe(true)
    expect(query.results.some(row => row.detail.includes('SCAN configuration_entries'))).toBe(false)
    const joined = await env.EVENTS_DB.prepare(`EXPLAIN QUERY PLAN
      SELECT authority.mode, entry.value FROM configuration_authority AS authority
      LEFT JOIN configuration_entries AS entry ON entry.namespace = ? AND entry.entry_key = ?
      WHERE authority.singleton = 1`).bind('SUBS', SUBSCRIPTION_KEY).all<{ detail: string }>()
    expect(joined.results.every(row => row.detail.includes('SEARCH'))).toBe(true)
  })

  it('enforces inventory and byte ceilings within the atomic database statement', async () => {
    const oversized = Array.from({ length: CONFIGURATION_LIMITS.ENTRIES + 1 }, (_value, index) => ({
      namespace: 'SINKS', key: `sink:synthetic-${index}`, resourceId: crypto.randomUUID(), value: '{}',
    }))
    await expect(accept(0, change({ puts: oversized }))).rejects.toThrow()
    const largeValue = JSON.stringify({ value: 'x'.repeat(CONFIGURATION_LIMITS.ENTRY_BYTES - 32) })
    const byteOverflow = Array.from({ length: Math.ceil(CONFIGURATION_LIMITS.CHANGE_BYTES / largeValue.length) }, (_value, index) => ({
      namespace: 'SINKS', key: `sink:synthetic-${index}`, resourceId: crypto.randomUUID(), value: largeValue,
    }))
    await expect(accept(0, change({ puts: byteOverflow }))).rejects.toThrow()
    expect((await env.EVENTS_DB.prepare('SELECT revision FROM configuration_authority').first())?.revision).toBe(0)
    expect((await env.EVENTS_DB.prepare('SELECT count(*) AS count FROM configuration_entries').first())?.count).toBe(0)
  })
})
