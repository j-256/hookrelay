import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptConfigurationChange,
  configurationQuery,
  readConfigurationEntries,
  readConfigurationState,
  type ConfigurationQuery,
} from '../../src/configuration/authority'
import {
  applyProviderConfiguration,
  planProviderConfiguration,
  readProviderConfiguration,
  type ProviderConfigurationDependencies,
} from '../../scripts/provider-configuration'

const KEY = `sub:sha256:${'8'.repeat(64)}`
const NEXT_KEY = `sub:sha256:${'9'.repeat(64)}`
const RESOURCE = '00000000-0000-4000-8000-000000000008'
const TEMPORARY = '00000000-0000-4000-8000-000000000009'
const query = configurationQuery(env.EVENTS_DB)
const owner = {
  clientId: 'cloudflare-operator',
  clientRevision: 1,
  workspaceId: 'provider',
  actorId: 'account-operator',
}

beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec("DELETE FROM configuration_aliases; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL")
})

async function activate() {
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, {
    ...owner,
    authorityId: state.authorityId,
    expectedRevision: 0,
    operationId: crypto.randomUUID(),
    resourceId: null,
    kind: 'migration',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    puts: [{ namespace: 'SUBS', key: KEY, resourceId: RESOURCE, value: JSON.stringify({ name: 'one' }) }],
    deletes: [],
  })
}

describe('storage-neutral provider configuration', () => {
  it('reads legacy KV only while the authority remains legacy', async () => {
    const snapshot = await readProviderConfiguration({
      query,
      readLegacy: async () => ({ subs: { [KEY]: '{"name":"legacy"}' }, sinks: {} }),
    })
    expect(snapshot.state.mode).toBe('legacy')
    expect(snapshot.subs[KEY]).toContain('legacy')
    expect(snapshot.entries).toEqual([])
  })

  it('applies an active lifecycle plan with stable identities and a receipt', async () => {
    await activate()
    const snapshot = await readProviderConfiguration({ query })
    const plan = await planProviderConfiguration(snapshot, {
      puts: [{ namespace: 'SUBS', key: KEY, value: JSON.stringify({ name: 'updated' }) }],
    }, { query, randomUuid: () => '10000000-0000-4000-8000-000000000001' })
    expect(plan.mode).toBe('active')
    const receipt = await applyProviderConfiguration(plan, { query })
    expect(receipt).toMatchObject({ kind: 'lifecycle', resourceId: RESOURCE, revision: 2 })
    expect(await readConfigurationEntries(query)).toEqual([{
      namespace: 'SUBS', key: KEY, resourceId: RESOURCE, retired: false,
      value: JSON.stringify({ name: 'updated' }),
    }])
  })

  it('rekeys over a temporary overlap and materializes the retained alias', async () => {
    await activate()
    let snapshot = await readProviderConfiguration({ query })
    const overlap = await planProviderConfiguration(snapshot, {
      puts: [{ namespace: 'SUBS', key: NEXT_KEY, value: JSON.stringify({ name: 'one' }) }],
    }, { query, randomUuid: () => TEMPORARY })
    await applyProviderConfiguration(overlap, { query })

    snapshot = await readProviderConfiguration({ query })
    const canonical = await planProviderConfiguration(snapshot, {
      rekeys: [{
        namespace: 'SUBS', fromKey: KEY, toKey: NEXT_KEY,
        retainFromAlias: true, replaceTarget: true,
      }],
    }, { query, randomUuid: () => '10000000-0000-4000-8000-000000000002' })
    await applyProviderConfiguration(canonical, { query })

    const result = await readProviderConfiguration({ query })
    expect(result.entries).toMatchObject([{ key: NEXT_KEY, resourceId: RESOURCE }])
    expect(result.aliases).toEqual([{ namespace: 'SUBS', key: KEY, resourceId: RESOURCE }])
    expect(result.subs[KEY]).toEqual(result.subs[NEXT_KEY])

    const repeated = await planProviderConfiguration(result, {
      rekeys: [{
        namespace: 'SUBS', fromKey: KEY, toKey: NEXT_KEY,
        retainFromAlias: true, replaceTarget: true,
      }],
    }, { query, randomUuid: () => '10000000-0000-4000-8000-000000000099' })
    expect(repeated.mode === 'active' && repeated.review).toBeNull()
    expect(await applyProviderConfiguration(repeated, { query })).toBeNull()
    expect(await readConfigurationState(query)).toMatchObject({ revision: 3 })

    const removeAlias = await planProviderConfiguration(result, {
      aliasDeletes: [{ namespace: 'SUBS', key: KEY }],
    }, { query, randomUuid: () => '10000000-0000-4000-8000-000000000098' })
    await applyProviderConfiguration(removeAlias, { query })
    const cleaned = await readProviderConfiguration({ query })
    const completed = await planProviderConfiguration(cleaned, {
      rekeys: [{
        namespace: 'SUBS', fromKey: KEY, toKey: NEXT_KEY,
        retainFromAlias: true, replaceTarget: true, allowMissingSourceIfTarget: true,
      }],
    }, { query, randomUuid: () => '10000000-0000-4000-8000-000000000097' })
    expect(completed.mode === 'active' && completed.review).toBeNull()
  })

  it('keeps a sink resource identity while replacing its temporary rename target', async () => {
    await activate()
    let sequence = 20
    const nextUuid = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`
    let snapshot = await readProviderConfiguration({ query })
    const overlap = await planProviderConfiguration(snapshot, {
      puts: [
        { namespace: 'SINKS', key: 'sink:old-name', value: JSON.stringify({ type: 'ntfy', topic: 'same' }) },
        { namespace: 'SINKS', key: 'sink:new-name', value: JSON.stringify({ type: 'ntfy', topic: 'same' }) },
      ],
    }, { query, randomUuid: nextUuid })
    await applyProviderConfiguration(overlap, { query })
    snapshot = await readProviderConfiguration({ query })
    const oldResourceId = snapshot.entries.find(entry => entry.key === 'sink:old-name')!.resourceId
    const temporaryResourceId = snapshot.entries.find(entry => entry.key === 'sink:new-name')!.resourceId

    const renamed = await planProviderConfiguration(snapshot, {
      rekeys: [{
        namespace: 'SINKS',
        fromKey: 'sink:old-name',
        toKey: 'sink:new-name',
        retainFromAlias: true,
        replaceTarget: true,
      }],
    }, { query, randomUuid: nextUuid })
    await applyProviderConfiguration(renamed, { query })

    const result = await readProviderConfiguration({ query })
    expect(result.entries.find(entry => entry.key === 'sink:new-name')).toMatchObject({ resourceId: oldResourceId })
    expect(result.entries.some(entry => entry.resourceId === temporaryResourceId)).toBe(false)
    expect(result.aliases).toContainEqual({ namespace: 'SINKS', key: 'sink:old-name', resourceId: oldResourceId })
    expect(result.sinks['sink:old-name']).toEqual(result.sinks['sink:new-name'])
  })

  it('reconciles a receipt after the acceptance response is lost', async () => {
    await activate()
    const snapshot = await readProviderConfiguration({ query })
    const operationId = '10000000-0000-4000-8000-000000000003'
    const plan = await planProviderConfiguration(snapshot, {
      puts: [{ namespace: 'SUBS', key: KEY, value: JSON.stringify({ name: 'recovered' }) }],
    }, { query, randomUuid: () => operationId })
    let lost = false
    const losingQuery: ConfigurationQuery = async statement => {
      const rows = await query(statement)
      if (!lost && statement.sql.startsWith('UPDATE configuration_authority')) {
        lost = true
        throw new Error('synthetic response loss')
      }
      return rows as never
    }
    expect(await applyProviderConfiguration(plan, { query: losingQuery })).toMatchObject({ id: operationId, revision: 2 })
  })

  it('retains legacy write behavior without creating D1 receipts', async () => {
    const writes: string[] = []
    const legacy: ProviderConfigurationDependencies = {
      query,
      readLegacy: async () => ({ subs: { [KEY]: '{}' }, sinks: {} }),
      putLegacy: async (binding, key) => { writes.push(`put:${binding}:${key}`) },
      deleteLegacy: async (binding, key) => { writes.push(`delete:${binding}:${key}`) },
    }
    const snapshot = await readProviderConfiguration(legacy)
    const plan = await planProviderConfiguration(snapshot, {
      puts: [{ namespace: 'SINKS', key: 'sink:new', value: '{}' }],
      deletes: [{ namespace: 'SUBS', key: KEY }],
    }, legacy)
    expect(await applyProviderConfiguration(plan, legacy)).toBeNull()
    expect(writes).toEqual([`put:SINKS:sink:new`, `delete:SUBS:${KEY}`])
  })
})
