import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptConfigurationChange, configurationQuery, readConfigurationEntries, readConfigurationReceipt,
  readConfigurationState, readRuntimeConfiguration, type ConfigurationChange, type ConfigurationQuery,
} from '../../src/configuration/authority'

const KEY = `sub:sha256:${'c'.repeat(64)}`
const RESOURCE = '00000000-0000-4000-8000-000000000002'
const PRIVATE = 'synthetic-private-route-configuration'
const owner = { clientId: 'hq', clientRevision: 1, workspaceId: 'workspace', actorId: 'owner' }
const query = configurationQuery(env.EVENTS_DB)

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM configuration_entries; DELETE FROM configuration_receipts; UPDATE configuration_authority SET revision = 0, mode = \'legacy\', operation_id = NULL, pending_change = NULL;')
})

async function candidate(overrides: Partial<ConfigurationChange> = {}): Promise<ConfigurationChange> {
  const state = await readConfigurationState(query)
  return {
    ...owner, authorityId: state.authorityId, operationId: crypto.randomUUID(), expectedRevision: 0,
    kind: 'migration', resourceId: null, expiresAt: new Date(Date.now() + 60000).toISOString(),
    puts: [{ namespace: 'SUBS', key: KEY, resourceId: RESOURCE, value: JSON.stringify({ name: PRIVATE }) }],
    deletes: [], ...overrides,
  }
}

describe('shared configuration authority', () => {
  it('retains resource identity on updates and never falls back to KV after activation', async () => {
    await env.SUBS.put(KEY, JSON.stringify({ name: 'legacy-value' }))
    expect(await readRuntimeConfiguration(env, 'SUBS', KEY)).toContain('legacy-value')
    await acceptConfigurationChange(query, await candidate())
    expect(await readRuntimeConfiguration(env, 'SUBS', KEY)).toContain(PRIVATE)
    await env.SUBS.put('sink:legacy-only', '{}')
    expect(await readRuntimeConfiguration(env, 'SUBS', 'sink:legacy-only')).toBeNull()
    await acceptConfigurationChange(query, await candidate({
      expectedRevision: 1, kind: 'policy', resourceId: RESOURCE,
      puts: [{ namespace: 'SUBS', key: KEY, resourceId: RESOURCE, value: JSON.stringify({ name: 'renamed' }) }],
    }))
    expect(await readConfigurationEntries(query)).toEqual([
      { namespace: 'SUBS', key: KEY, resourceId: RESOURCE, retired: false, value: JSON.stringify({ name: 'renamed' }) },
    ])
  })

  it('reconciles a lost acceptance response through the same immutable receipt', async () => {
    const input = await candidate()
    const dropResponse: ConfigurationQuery = async statement => {
      const result = await query(statement)
      if (statement.sql.startsWith('UPDATE configuration_authority')) throw new Error('synthetic lost response')
      return result as never
    }
    await expect(acceptConfigurationChange(dropResponse, input)).rejects.toThrow('synthetic lost response')
    const recovered = await acceptConfigurationChange(query, input)
    expect(recovered).toMatchObject({ id: input.operationId, revision: 1, beforeRevision: 0 })
    expect(JSON.stringify(recovered)).not.toContain(PRIVATE)
    expect(await readConfigurationState(query)).toMatchObject({ revision: 1 })
    expect(await readConfigurationReceipt(query, input.operationId, owner)).toEqual(recovered)
  })

  it('rejects stale drafts, authority mismatches and reused IDs with changed inputs', async () => {
    const input = await candidate()
    await acceptConfigurationChange(query, input)
    await expect(acceptConfigurationChange(query, await candidate())).rejects.toMatchObject({ code: 'conflict' })
    await expect(acceptConfigurationChange(query, { ...input, deletes: [{ namespace: 'SINKS', key: 'sink:other' }], kind: 'import' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(acceptConfigurationChange(query, await candidate({ expectedRevision: 1, kind: 'import', authorityId: 'f'.repeat(32) }))).rejects.toMatchObject({ code: 'conflict' })
    expect(await readConfigurationState(query)).toMatchObject({ revision: 1 })
  })

  it('does not disclose another actor, workspace or credential revision receipt', async () => {
    const input = await candidate()
    await acceptConfigurationChange(query, input)
    for (const changed of [{ actorId: 'other' }, { workspaceId: 'other' }, { clientId: 'other' }, { clientRevision: 2 }]) {
      await expect(readConfigurationReceipt(query, input.operationId, { ...owner, ...changed })).rejects.toMatchObject({ code: 'not_found' })
      await expect(acceptConfigurationChange(query, { ...input, ...changed })).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('rejects expired reviews and entry identity replacement', async () => {
    await expect(acceptConfigurationChange(query, await candidate({ expiresAt: '2020-01-01T00:00:00.000Z' }))).rejects.toMatchObject({ code: 'expired' })
    await acceptConfigurationChange(query, await candidate())
    await expect(acceptConfigurationChange(query, await candidate({
      kind: 'import', expectedRevision: 1,
      puts: [{ namespace: 'SUBS', key: KEY, resourceId: crypto.randomUUID(), value: '{}' }],
    }))).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects invalid and oversized private input with fixed messages', async () => {
    const input = await candidate()
    for (const value of [PRIVATE, JSON.stringify({ value: PRIVATE.repeat(10000) })]) {
      await expect(acceptConfigurationChange(query, { ...input, puts: [{ ...input.puts[0]!, value }] })).rejects.toMatchObject({
        code: 'validation', message: 'The configuration change is invalid or exceeds its supported bounds',
      })
    }
    expect(await readConfigurationState(query)).toMatchObject({ revision: 0, mode: 'legacy' })
  })

  it('rejects new acceptance if the review expires at the database boundary', async () => {
    const input = await candidate()
    const expireAtAcceptance: ConfigurationQuery = async statement => {
      if (!statement.sql.startsWith('UPDATE configuration_authority')) return query(statement) as never
      const params = [...statement.params]
      params[params.length - 1] = '2020-01-01T00:00:00.000Z'
      return query({ ...statement, params }) as never
    }
    await expect(acceptConfigurationChange(expireAtAcceptance, input)).rejects.toMatchObject({ code: 'conflict' })
    expect(await readConfigurationState(query)).toMatchObject({ revision: 0 })
  })

  it('serializes competing changes through one authority revision', async () => {
    const inputs = await Promise.all([candidate(), candidate()])
    const outcomes = await Promise.allSettled(inputs.map(input => acceptConfigurationChange(query, input)))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await readConfigurationState(query)).toMatchObject({ revision: 1 })
  })
})
