import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  configurationDigest, configurationQuery, readConfigurationEntries, readConfigurationState,
  type ConfigurationQuery,
} from '../../src/configuration/authority'
import {
  applyConfigurationReview, configurationReviewSummary, exportConfiguration, parseConfigurationReview,
  reviewConfigurationImport, reviewConfigurationMigration,
} from '../../scripts/configuration-workflow'
import { computePlan, parseRoutes } from '../../scripts/sync'

const PRIVATE = 'synthetic-private-operator-value'
const KEY = `sub:sha256:${'e'.repeat(64)}`
const routes = {
  subs: [{ name: 'example', source: 'statuspage', slugHash: 'e'.repeat(64), enabled: true, sinks: ['phone'], auth: null }],
  sinks: [{ name: 'phone', type: 'ntfy', topic: PRIVATE }],
  retention: { d1Days: 60 },
}
const plan = computePlan(parseRoutes(JSON.stringify(routes)), { subs: {}, sinks: {} })
const snapshot = {
  subs: Object.fromEntries(plan.subPuts.map(entry => [entry.key, entry.value])),
  sinks: Object.fromEntries(plan.sinkPuts.map(entry => [entry.key, entry.value])),
}
const query = configurationQuery(env.EVENTS_DB)

beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM configuration_policy_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; UPDATE configuration_authority SET revision = 0, mode = \'legacy\', operation_id = NULL, pending_change = NULL;')
})

async function migrate() {
  const review = await reviewConfigurationMigration(query, snapshot, JSON.stringify(routes))
  await applyConfigurationReview(query, review, async () => snapshot)
  return review
}

function disable(exported: Awaited<ReturnType<typeof exportConfiguration>>) {
  return { ...exported, entries: exported.entries.map(entry => entry.key === KEY
    ? { ...entry, value: JSON.stringify({ ...JSON.parse(entry.value), enabled: false }) } : entry) }
}

describe('revision-bound operator workflows', () => {
  it('requires an explicit migration apply and preserves every legacy value', async () => {
    const review = await reviewConfigurationMigration(query, snapshot, JSON.stringify(routes))
    expect(await readConfigurationState(query)).toMatchObject({ mode: 'legacy', revision: 0 })
    expect(JSON.stringify(configurationReviewSummary(review))).not.toContain(PRIVATE)
    expect(JSON.stringify(configurationReviewSummary(review))).not.toContain(KEY)
    const receipt = await applyConfigurationReview(query, review, async () => ({
      ...snapshot, subs: { ...snapshot.subs, 'ops-fallback:synthetic': 'operational state is not configuration' },
    }))
    expect(receipt).toMatchObject({ revision: 1, kind: 'migration' })
    const entries = await readConfigurationEntries(query)
    expect(Object.fromEntries(entries.filter(entry => entry.namespace === 'SUBS').map(entry => [entry.key, entry.value]))).toEqual(snapshot.subs)
    expect(Object.fromEntries(entries.filter(entry => entry.namespace === 'SINKS').map(entry => [entry.key, entry.value]))).toEqual(snapshot.sinks)
    expect(await applyConfigurationReview(query, review, async () => { throw new Error('must not reread obsolete KV after acceptance') })).toEqual(receipt)
  })

  it('refuses migration drift before review or apply and never silently changes values at activation', async () => {
    await expect(reviewConfigurationMigration(query, snapshot, JSON.stringify({ ...routes, subs: [] }))).rejects.toMatchObject({ code: 'conflict' })
    const review = await reviewConfigurationMigration(query, snapshot, JSON.stringify(routes))
    await expect(applyConfigurationReview(query, review, async () => ({ ...snapshot, sinks: {} }))).rejects.toMatchObject({ code: 'conflict' })
    const altered = structuredClone(review)
    altered.change.puts[0]!.value = JSON.stringify({ changed: PRIVATE })
    const { fingerprint: _old, ...content } = altered
    altered.fingerprint = await configurationDigest(content)
    await expect(applyConfigurationReview(query, altered, async () => snapshot)).rejects.toMatchObject({ code: 'validation' })
    expect(await readConfigurationState(query)).toMatchObject({ revision: 0 })
  })

  it('carries retired sink state without removing configuration or touching credentials', async () => {
    const retiredRoutes = { ...routes, subs: [{ ...routes.subs[0]!, enabled: false }], sinks: [], retiredSinks: routes.sinks }
    const retiredPlan = computePlan(parseRoutes(JSON.stringify(retiredRoutes)), { subs: {}, sinks: {} })
    const retiredSnapshot = { subs: Object.fromEntries(retiredPlan.subPuts.map(entry => [entry.key, entry.value])), sinks: snapshot.sinks }
    const review = await reviewConfigurationMigration(query, retiredSnapshot, JSON.stringify(retiredRoutes))
    await applyConfigurationReview(query, review, async () => retiredSnapshot)
    expect((await exportConfiguration(query)).entries.find(entry => entry.key === 'sink:phone')).toMatchObject({ retired: true })
    const draft = await exportConfiguration(query)
    draft.entries.find(entry => entry.key === KEY)!.value = JSON.stringify({ ...JSON.parse(draft.entries.find(entry => entry.key === KEY)!.value), enabled: true })
    await expect(reviewConfigurationImport(query, draft)).rejects.toMatchObject({ code: 'validation' })
  })

  it('imports only reviewed policy changes and retains the exact private recovery baseline', async () => {
    await migrate()
    const before = await exportConfiguration(query)
    await expect(reviewConfigurationImport(query, before)).rejects.toMatchObject({ code: 'validation', message: 'The imported subscription policies are unchanged' })
    const review = await reviewConfigurationImport(query, disable(before))
    expect(review.before).toEqual(before)
    expect(await exportConfiguration(query)).toEqual(before)
    const receipt = await applyConfigurationReview(query, review, async () => { throw new Error('active imports must not read KV') })
    expect(receipt).toMatchObject({ revision: 2, kind: 'import' })
    expect(JSON.parse((await readConfigurationEntries(query)).find(entry => entry.key === KEY)!.value).enabled).toBe(false)
    expect(await applyConfigurationReview(query, review, async () => snapshot)).toEqual(receipt)
    await expect(reviewConfigurationImport(query, disable(before))).rejects.toMatchObject({ code: 'conflict' })
  })

  it('recovers a lost acceptance response with the same review and does not repeat the change', async () => {
    await migrate()
    const review = await reviewConfigurationImport(query, disable(await exportConfiguration(query)))
    const loseResponse: ConfigurationQuery = async statement => {
      const result = await query(statement)
      if (statement.sql.startsWith('UPDATE configuration_authority')) throw new Error('synthetic response loss')
      return result as never
    }
    await expect(applyConfigurationReview(loseResponse, review, async () => snapshot)).rejects.toThrow('synthetic response loss')
    expect(await applyConfigurationReview(query, review, async () => snapshot)).toMatchObject({ revision: 2 })
    expect(await readConfigurationState(query)).toMatchObject({ revision: 2 })
  })

  it('refuses creation, deletion, renaming, credential replacement and tampered reviews', async () => {
    await migrate()
    const before = await exportConfiguration(query)
    const missing = { ...before, entries: before.entries.slice(1) }
    await expect(reviewConfigurationImport(query, missing)).rejects.toMatchObject({ code: 'validation' })
    for (const update of [{ name: 'renamed' }, { auth: { scheme: 'other', secretEnv: PRIVATE } }]) {
      const draft = structuredClone(before)
      const entry = draft.entries.find(value => value.key === KEY)!
      entry.value = JSON.stringify({ ...JSON.parse(entry.value), ...update })
      await expect(reviewConfigurationImport(query, draft)).rejects.toMatchObject({ code: 'validation' })
    }
    const review = await reviewConfigurationImport(query, disable(before))
    const changed = structuredClone(review)
    changed.change.puts[0]!.value = JSON.stringify({ ...JSON.parse(changed.change.puts[0]!.value), auth: { secretEnv: PRIVATE } })
    await expect(parseConfigurationReview(changed)).rejects.toMatchObject({ code: 'validation' })
    const { fingerprint: _old, ...content } = changed
    changed.fingerprint = await configurationDigest(content)
    await expect(applyConfigurationReview(query, changed, async () => snapshot)).rejects.toMatchObject({ code: 'validation' })
    expect(await exportConfiguration(query)).toEqual(before)
  })

  it('fails closed when the authority cannot be read', async () => {
    const unavailable: ConfigurationQuery = async () => { throw new Error('synthetic database unavailable') }
    await expect(exportConfiguration(unavailable)).rejects.toThrow('synthetic database unavailable')
  })
})
