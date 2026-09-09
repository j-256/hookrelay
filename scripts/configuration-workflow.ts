import { z } from 'zod'
import {
  CONFIGURATION_LIMITS, CONFIGURATION_MODE, ConfigurationError, acceptConfigurationChange,
  authorityIdSchema, canonicalConfiguration, configurationAliasSchema, configurationDigest,
  configurationEntrySchema, readConfigurationAliases, readConfigurationEntries,
  readConfigurationReceipt, readConfigurationState, validateConfigurationChange,
  type ConfigurationChange, type ConfigurationEntry, type ConfigurationQuery,
  type ValidatedConfigurationChange,
} from '../src/configuration/authority'
import { applySubscriptionPolicy, readSubscriptionPolicy } from '../src/configuration/policy'
import { OPERATIONS_FALLBACK_PREFIX } from '../src/lib/runtime-config'
import { CONFIGURATION_OPERATOR } from './configuration-client'
import { computePlan, parseRoutes } from './sync'
import type { RemoteKvSnapshot } from './kv'

export { CONFIGURATION_OPERATOR } from './configuration-client'
export const configurationExportSchema = z.object({
  version: z.literal(1), authorityId: authorityIdSchema, revision: z.number().int().nonnegative(),
  entries: z.array(configurationEntrySchema).max(CONFIGURATION_LIMITS.ENTRIES),
  aliases: z.array(configurationAliasSchema).max(CONFIGURATION_LIMITS.ALIASES).default([]),
}).strict()
export type ConfigurationExport = z.infer<typeof configurationExportSchema>
function configurationValue(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch {
    throw new ConfigurationError('validation', 'A private configuration entry contains invalid JSON')
  }
}
const snapshotSchema = z.object({ subs: z.record(z.string(), z.string()), sinks: z.record(z.string(), z.string()) }).strict()
const reviewSchema = z.object({
  version: z.literal(1), before: configurationExportSchema, change: z.unknown(),
  legacySnapshot: snapshotSchema.nullable(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export interface OperatorConfigurationReview {
  version: 1
  before: ConfigurationExport
  change: ValidatedConfigurationChange
  legacySnapshot: RemoteKvSnapshot | null
  fingerprint: string
}

export async function exportConfiguration(query: ConfigurationQuery): Promise<ConfigurationExport> {
  const state = await readConfigurationState(query)
  const [entries, aliases] = await Promise.all([
    readConfigurationEntries(query),
    readConfigurationAliases(query),
  ])
  const observed = await readConfigurationState(query)
  if (state.authorityId !== observed.authorityId || state.revision !== observed.revision || state.mode !== observed.mode) {
    throw new ConfigurationError('conflict', 'Configuration changed during export; retry the read')
  }
  return configurationExportSchema.parse({
    version: 1, authorityId: state.authorityId, revision: state.revision, entries, aliases,
  })
}

function normalizedSnapshot(snapshot: RemoteKvSnapshot): RemoteKvSnapshot {
  const normalize = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => {
    try { return [key, canonicalConfiguration(JSON.parse(value))] } catch {
      throw new ConfigurationError('validation', 'Legacy configuration contains invalid JSON; repair it before migration')
    }
  }))
  return {
    subs: normalize(Object.fromEntries(Object.entries(snapshot.subs).filter(([key]) => !key.startsWith(OPERATIONS_FALLBACK_PREFIX)))),
    sinks: normalize(snapshot.sinks),
  }
}

async function sealReview(before: ConfigurationExport, change: ConfigurationChange, legacySnapshot: RemoteKvSnapshot | null): Promise<OperatorConfigurationReview> {
  const validated = validateConfigurationChange(change)
  const content = { version: 1 as const, before, change: validated, legacySnapshot }
  return { ...content, fingerprint: await configurationDigest(content) }
}

function baseChange(before: ConfigurationExport, kind: ConfigurationChange['kind']): ValidatedConfigurationChange {
  return {
    ...CONFIGURATION_OPERATOR, authorityId: before.authorityId, expectedRevision: before.revision,
    operationId: crypto.randomUUID(), resourceId: null, kind,
    expiresAt: new Date(Date.now() + CONFIGURATION_LIMITS.REVIEW_TTL_MS).toISOString(),
    puts: [], deletes: [], moves: [], aliasPuts: [], aliasDeletes: [],
  }
}

export async function reviewConfigurationMigration(query: ConfigurationQuery, snapshot: RemoteKvSnapshot, routesText: string) {
  const state = await readConfigurationState(query)
  if (state.mode !== CONFIGURATION_MODE.LEGACY || state.revision !== 0) {
    throw new ConfigurationError('conflict', 'Migration requires an unactivated configuration authority')
  }
  let routes: ReturnType<typeof parseRoutes>
  try { routes = parseRoutes(routesText) } catch {
    throw new ConfigurationError('validation', 'The private legacy routes file is invalid')
  }
  const normalized = normalizedSnapshot(snapshot)
  const plan = computePlan(routes, normalized)
  if (Object.values(plan).some(entries => entries.length > 0)) {
    throw new ConfigurationError('conflict', 'Legacy routes and provider configuration differ; reconcile them before migration')
  }
  const retired = new Set((routes.retiredSinks ?? []).map(sink => `sink:${sink.name}`))
  const entries: ConfigurationEntry[] = [
    ...Object.entries(normalized.subs).map(([key, value]) => ({ namespace: 'SUBS' as const, key, value, retired: false, resourceId: crypto.randomUUID() })),
    ...Object.entries(normalized.sinks).map(([key, value]) => ({ namespace: 'SINKS' as const, key, value, retired: retired.has(key), resourceId: crypto.randomUUID() })),
  ]
  const before = await exportConfiguration(query)
  if (before.entries.length) throw new ConfigurationError('conflict', 'The inactive authority contains unexpected entries; inspect recovery state before migration')
  return sealReview(before, { ...baseChange(before, 'migration'), puts: entries }, normalized)
}

export async function reviewConfigurationImport(query: ConfigurationQuery, input: unknown): Promise<OperatorConfigurationReview> {
  let candidate: ConfigurationExport
  try { candidate = configurationExportSchema.parse(input) } catch {
    throw new ConfigurationError('validation', 'The private import document does not match the versioned export format')
  }
  const state = await readConfigurationState(query)
  if (state.mode !== CONFIGURATION_MODE.ACTIVE) throw new ConfigurationError('inactive', 'Activate the provider authority before importing policy changes')
  const before = await exportConfiguration(query)
  if (candidate.authorityId !== before.authorityId || candidate.revision !== before.revision) {
    throw new ConfigurationError('conflict', 'The import baseline is stale; export the latest revision and reconcile the draft explicitly')
  }
  const byId = new Map(candidate.entries.map(entry => [entry.resourceId, entry]))
  if (byId.size !== candidate.entries.length || byId.size !== before.entries.length) {
    throw new ConfigurationError('validation', 'Imports cannot create or retire resources; staged lifecycle workflows are required')
  }
  const puts: ConfigurationEntry[] = []
  for (const old of before.entries) {
    const next = byId.get(old.resourceId)
    if (!next || next.namespace !== old.namespace || next.key !== old.key || next.retired !== old.retired) {
      throw new ConfigurationError('validation', 'Imports cannot replace resource identity or lifecycle state')
    }
    if (canonicalConfiguration(configurationValue(next.value)) === canonicalConfiguration(configurationValue(old.value))) continue
    const policy = readSubscriptionPolicy(next).policy
    const expected = applySubscriptionPolicy(old, policy)
    if (canonicalConfiguration(configurationValue(expected.value)) !== canonicalConfiguration(configurationValue(next.value))) {
      throw new ConfigurationError('validation', 'Imports support subscription policy only; credentials, names and other provider settings cannot be changed')
    }
    for (const sinkName of policy.sinks) {
      const sink = before.entries.find(entry => entry.namespace === 'SINKS' && entry.key === `sink:${sinkName}`)
      if (!sink || (policy.enabled && sink.retired)) throw new ConfigurationError('validation', 'Enabled policies require existing, non-retired destinations')
    }
    puts.push(expected)
  }
  if (!puts.length) throw new ConfigurationError('validation', 'The imported subscription policies are unchanged')
  return sealReview(before, { ...baseChange(before, 'import'), puts }, null)
}

export async function parseConfigurationReview(input: unknown): Promise<OperatorConfigurationReview> {
  try {
    const parsed = reviewSchema.parse(input)
    const change = validateConfigurationChange(parsed.change)
    const content = { version: 1 as const, before: parsed.before, change, legacySnapshot: parsed.legacySnapshot }
    if (await configurationDigest(content) !== parsed.fingerprint) throw new Error()
    if (change.authorityId !== parsed.before.authorityId || change.expectedRevision !== parsed.before.revision ||
        change.clientId !== CONFIGURATION_OPERATOR.clientId || change.clientRevision !== CONFIGURATION_OPERATOR.clientRevision ||
        change.workspaceId !== CONFIGURATION_OPERATOR.workspaceId || change.actorId !== CONFIGURATION_OPERATOR.actorId) throw new Error()
    if (change.kind === 'policy' || change.resourceId !== null ||
        (change.kind === 'migration') !== (parsed.legacySnapshot !== null)) throw new Error()
    return { ...content, fingerprint: parsed.fingerprint }
  } catch {
    throw new ConfigurationError('validation', 'The private review is invalid or changed; create a new review')
  }
}

export async function applyConfigurationReview(
  query: ConfigurationQuery, review: OperatorConfigurationReview, readLegacy: () => Promise<RemoteKvSnapshot>,
) {
  const validated = await parseConfigurationReview(review)
  const previous = await readConfigurationReceipt(query, validated.change.operationId, CONFIGURATION_OPERATOR)
  if (previous) return acceptConfigurationChange(query, validated.change)
  if (validated.change.kind === 'migration') {
    const observed = normalizedSnapshot(await readLegacy())
    if (canonicalConfiguration(observed) !== canonicalConfiguration(validated.legacySnapshot)) {
      throw new ConfigurationError('conflict', 'Legacy provider configuration changed after review; migration was not applied')
    }
    const planned = normalizedSnapshot({
      subs: Object.fromEntries(validated.change.puts.filter(entry => entry.namespace === 'SUBS').map(entry => [entry.key, entry.value])),
      sinks: Object.fromEntries(validated.change.puts.filter(entry => entry.namespace === 'SINKS').map(entry => [entry.key, entry.value])),
    })
    if (canonicalConfiguration(planned) !== canonicalConfiguration(observed)) {
      throw new ConfigurationError('validation', 'Migration must preserve the observed provider configuration exactly')
    }
  } else {
    if (validated.change.deletes.length) throw new ConfigurationError('validation', 'Policy imports cannot retire resources')
    const replacements = new Map(validated.change.puts.map(entry => [entry.resourceId, entry]))
    const candidate = {
      ...validated.before,
      entries: validated.before.entries.map(entry => replacements.get(entry.resourceId) ?? entry),
    }
    const verified = await reviewConfigurationImport(query, candidate)
    const semanticEntries = (entries: ConfigurationEntry[]) => entries.map(entry => ({ ...entry, value: configurationValue(entry.value) }))
    if (canonicalConfiguration(verified.before) !== canonicalConfiguration(validated.before) ||
        canonicalConfiguration(semanticEntries(verified.change.puts)) !== canonicalConfiguration(semanticEntries(validated.change.puts))) {
      throw new ConfigurationError('validation', 'The private review does not match supported policy changes against its saved baseline')
    }
  }
  return acceptConfigurationChange(query, validated.change)
}

export function configurationReviewSummary(review: OperatorConfigurationReview) {
  const changedResourceIds = new Set<string>(review.change.puts.map(entry => entry.resourceId))
  return {
    operationId: review.change.operationId, kind: review.change.kind,
    authorityId: review.change.authorityId, expectedRevision: review.change.expectedRevision,
    changedResourceIds: [...changedResourceIds], expiresAt: review.change.expiresAt,
    movedResources: review.change.moves.length,
    aliasesChanged: review.change.aliasPuts.length + review.change.aliasDeletes.length,
    policyChanges: review.change.kind === 'import' ? review.change.puts.map(entry => ({
      resourceId: entry.resourceId,
      before: readSubscriptionPolicy(review.before.entries.find(previous => previous.resourceId === entry.resourceId)!).policy,
      after: readSubscriptionPolicy(entry).policy,
    })) : [],
    effect: review.change.kind === 'migration' ? 'activate-provider-configuration' : 'future-ingress-policy',
    privateRecoveryIncluded: true,
  }
}
