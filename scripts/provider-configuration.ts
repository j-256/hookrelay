import {
  CONFIGURATION_LIMITS,
  CONFIGURATION_MODE,
  ConfigurationError,
  acceptConfigurationChange,
  configurationDigest,
  readConfigurationAliases,
  readConfigurationEntries,
  readConfigurationReceipt,
  readConfigurationState,
  validateConfigurationChange,
  type ConfigurationAlias,
  type ConfigurationEntry,
  type ConfigurationMove,
  type ConfigurationQuery,
  type ConfigurationReceipt,
  type ConfigurationState,
  type ValidatedConfigurationChange,
} from '../src/configuration/authority'
import { runProcess } from './setup'
import { deleteRemoteKv, putRemoteKv, readRemoteKvSnapshot, type RemoteKvSnapshot } from './kv'
import { CONFIGURATION_OPERATOR, operatorConfigurationQuery } from './configuration-client'

export type ConfigurationNamespace = 'SUBS' | 'SINKS'
export type ConfigurationProgress = (message: string) => void

export interface ProviderConfigurationSnapshot extends RemoteKvSnapshot {
  state: ConfigurationState
  entries: ConfigurationEntry[]
  aliases: ConfigurationAlias[]
}

export interface ProviderConfigurationPut {
  namespace: ConfigurationNamespace
  key: string
  value: string
  retired?: boolean
}

type ResolvedConfigurationEntry = Omit<ConfigurationEntry, 'retired'> & { retired: boolean }

export interface ProviderConfigurationDelete {
  namespace: ConfigurationNamespace
  key: string
}

export interface ProviderConfigurationRekey {
  namespace: ConfigurationNamespace
  fromKey: string
  toKey: string
  retainFromAlias: boolean
  replaceTarget?: boolean
  value?: string
  retired?: boolean
}

export interface ProviderConfigurationMutation {
  puts?: ProviderConfigurationPut[]
  deletes?: ProviderConfigurationDelete[]
  rekeys?: ProviderConfigurationRekey[]
  aliasDeletes?: ProviderConfigurationDelete[]
}

export interface ProviderConfigurationDependencies {
  query?: ConfigurationQuery
  readLegacy?: (progress?: ConfigurationProgress) => Promise<RemoteKvSnapshot>
  putLegacy?: (binding: string, key: string, value: string) => Promise<void>
  deleteLegacy?: (binding: string, key: string) => Promise<void>
  randomUuid?: () => string
  now?: () => number
}

export interface LegacyConfigurationPlan {
  mode: 'legacy'
  before: ProviderConfigurationSnapshot
  mutation: Required<ProviderConfigurationMutation>
}

export interface ActiveConfigurationPlan {
  mode: 'active'
  before: ProviderConfigurationSnapshot
  mutation: Required<ProviderConfigurationMutation>
  review: LifecycleConfigurationReview | null
}

export type ProviderConfigurationPlan = LegacyConfigurationPlan | ActiveConfigurationPlan

interface LifecycleConfigurationReview {
  version: 1
  before: {
    version: 1
    authorityId: string
    revision: number
    entries: ConfigurationEntry[]
    aliases: ConfigurationAlias[]
  }
  change: ValidatedConfigurationChange
  legacySnapshot: null
  fingerprint: string
}

const DEFAULT_DEPENDENCIES: Required<Omit<ProviderConfigurationDependencies, 'query'>> = {
  readLegacy: (progress) => readRemoteKvSnapshot(runProcess, progress),
  putLegacy: (binding, key, value) => putRemoteKv(binding, key, value),
  deleteLegacy: (binding, key) => deleteRemoteKv(binding, key),
  randomUuid: crypto.randomUUID,
  now: Date.now,
}

function dependencies(input: ProviderConfigurationDependencies) {
  return { ...DEFAULT_DEPENDENCIES, ...input }
}

function identity(namespace: ConfigurationNamespace, key: string): string {
  return `${namespace}:${key}`
}

function valuesFromEntries(
  entries: readonly ConfigurationEntry[],
  aliases: readonly ConfigurationAlias[],
): RemoteKvSnapshot {
  const byResource = new Map(entries.map(entry => [entry.resourceId, entry]))
  const subs: Record<string, string> = {}
  const sinks: Record<string, string> = {}
  const target = (namespace: ConfigurationNamespace) => namespace === 'SUBS' ? subs : sinks
  for (const entry of entries) target(entry.namespace)[entry.key] = entry.value
  for (const alias of aliases) {
    const entry = byResource.get(alias.resourceId)
    if (!entry || entry.namespace !== alias.namespace || target(alias.namespace)[alias.key] !== undefined) {
      throw new ConfigurationError('unavailable', 'Configuration aliases could not be resolved safely')
    }
    target(alias.namespace)[alias.key] = entry.value
  }
  return { subs, sinks }
}

export async function readProviderConfiguration(
  input: ProviderConfigurationDependencies = {},
  progress?: ConfigurationProgress,
): Promise<ProviderConfigurationSnapshot> {
  const resolved = dependencies(input)
  const query = input.query ?? await operatorConfigurationQuery()
  progress?.('Reading provider configuration authority')
  const state = await readConfigurationState(query)
  if (state.mode === CONFIGURATION_MODE.LEGACY) {
    const legacy = await resolved.readLegacy(progress)
    const observed = await readConfigurationState(query)
    if (observed.authorityId !== state.authorityId || observed.revision !== state.revision || observed.mode !== state.mode) {
      throw new ConfigurationError('conflict', 'Configuration authority changed during the legacy read; retry')
    }
    return { ...legacy, state, entries: [], aliases: [] }
  }
  const [entries, aliases] = await Promise.all([
    readConfigurationEntries(query),
    readConfigurationAliases(query),
  ])
  const observed = await readConfigurationState(query)
  if (observed.authorityId !== state.authorityId || observed.revision !== state.revision || observed.mode !== state.mode) {
    throw new ConfigurationError('conflict', 'Configuration authority changed during the D1 read; retry')
  }
  return { ...valuesFromEntries(entries, aliases), state, entries, aliases }
}

function normalizeMutation(input: ProviderConfigurationMutation): Required<ProviderConfigurationMutation> {
  return {
    puts: input.puts ?? [],
    deletes: input.deletes ?? [],
    rekeys: input.rekeys ?? [],
    aliasDeletes: input.aliasDeletes ?? [],
  }
}

function entryMap(snapshot: ProviderConfigurationSnapshot): Map<string, ConfigurationEntry> {
  return new Map(snapshot.entries.map(entry => [identity(entry.namespace, entry.key), entry]))
}

function aliasMap(snapshot: ProviderConfigurationSnapshot): Map<string, ConfigurationAlias> {
  return new Map(snapshot.aliases.map(alias => [identity(alias.namespace, alias.key), alias]))
}

async function sealLifecycleReview(
  before: ProviderConfigurationSnapshot,
  change: ValidatedConfigurationChange,
): Promise<LifecycleConfigurationReview> {
  const exported = {
    version: 1 as const,
    authorityId: before.state.authorityId,
    revision: before.state.revision,
    entries: before.entries,
    aliases: before.aliases,
  }
  const content = { version: 1 as const, before: exported, change, legacySnapshot: null }
  return { ...content, fingerprint: await configurationDigest(content) }
}

export async function planProviderConfiguration(
  before: ProviderConfigurationSnapshot,
  input: ProviderConfigurationMutation,
  dependencyInput: ProviderConfigurationDependencies = {},
): Promise<ProviderConfigurationPlan> {
  const mutation = normalizeMutation(input)
  if (mutation.puts.length + mutation.deletes.length + mutation.rekeys.length + mutation.aliasDeletes.length === 0) {
    throw new ConfigurationError('validation', 'The provider configuration plan has no changes')
  }
  if (before.state.mode === CONFIGURATION_MODE.LEGACY) {
    if (mutation.rekeys.length || mutation.aliasDeletes.length) {
      throw new ConfigurationError('validation', 'Legacy configuration does not support authority aliases')
    }
    const selected: Required<ProviderConfigurationMutation> = {
      ...mutation,
      puts: mutation.puts.filter(put => {
        const values = put.namespace === 'SUBS' ? before.subs : before.sinks
        return values[put.key] !== put.value
      }),
      deletes: mutation.deletes.filter(deleted => {
        const values = deleted.namespace === 'SUBS' ? before.subs : before.sinks
        return values[deleted.key] !== undefined
      }),
    }
    return { mode: 'legacy', before, mutation: selected }
  }

  const resolved = dependencies(dependencyInput)
  const entries = entryMap(before)
  const aliases = aliasMap(before)
  const puts: ResolvedConfigurationEntry[] = []
  const deletes: ProviderConfigurationDelete[] = [...mutation.deletes]
  const moves: ConfigurationMove[] = []
  const aliasPuts: ConfigurationAlias[] = []
  const aliasDeletes: ProviderConfigurationDelete[] = [...mutation.aliasDeletes]

  for (const put of mutation.puts) {
    const key = identity(put.namespace, put.key)
    if (aliases.has(key)) {
      throw new ConfigurationError('conflict', 'An aliased configuration key must be changed through its canonical resource')
    }
    const existing = entries.get(key)
    if (existing && existing.value === put.value && existing.retired === (put.retired ?? existing.retired ?? false)) {
      continue
    }
    puts.push({
      ...put,
      resourceId: existing?.resourceId ?? resolved.randomUuid(),
      retired: put.retired ?? existing?.retired ?? false,
    })
  }

  for (const rekey of mutation.rekeys) {
    const sourceKey = identity(rekey.namespace, rekey.fromKey)
    const targetKey = identity(rekey.namespace, rekey.toKey)
    const source = entries.get(sourceKey)
    const target = entries.get(targetKey)
    const targetAlias = aliases.get(targetKey)
    const sourceAlias = aliases.get(sourceKey)
    if (!source && sourceAlias && target?.resourceId === sourceAlias.resourceId) {
      if (!rekey.retainFromAlias) aliasDeletes.push({ namespace: rekey.namespace, key: rekey.fromKey })
      if (rekey.value !== undefined || rekey.retired !== undefined) {
        const nextValue = rekey.value ?? target.value
        const nextRetired = rekey.retired ?? target.retired ?? false
        if (target.value !== nextValue || target.retired !== nextRetired) {
          puts.push({
            namespace: rekey.namespace,
            key: rekey.toKey,
            resourceId: target.resourceId,
            value: nextValue,
            retired: nextRetired,
          })
        }
      }
      continue
    }
    if (!source) throw new ConfigurationError('conflict', 'The canonical configuration resource to rekey is missing')
    if ((target || targetAlias) && !rekey.replaceTarget) {
      throw new ConfigurationError('conflict', 'The replacement configuration key already exists')
    }
    if (target) deletes.push({ namespace: rekey.namespace, key: rekey.toKey })
    if (targetAlias) aliasDeletes.push({ namespace: rekey.namespace, key: rekey.toKey })
    moves.push({ namespace: rekey.namespace, fromKey: rekey.fromKey, toKey: rekey.toKey })
    if (rekey.value !== undefined || rekey.retired !== undefined) {
      puts.push({
        namespace: rekey.namespace,
        key: rekey.toKey,
        resourceId: source.resourceId,
        value: rekey.value ?? source.value,
        retired: rekey.retired ?? source.retired ?? false,
      })
    }
    if (rekey.retainFromAlias) {
      aliasPuts.push({ namespace: rekey.namespace, key: rekey.fromKey, resourceId: source.resourceId })
    }
  }

  for (const deleted of deletes) {
    const key = identity(deleted.namespace, deleted.key)
    if (!entries.has(key) && aliases.has(key)) {
      aliasDeletes.push(deleted)
    }
  }
  const directDeletes = deletes.filter(deleted => entries.has(identity(deleted.namespace, deleted.key)))
  const uniqueAliasDeletes = [...new Map(aliasDeletes
    .filter(entry => aliases.has(identity(entry.namespace, entry.key)))
    .map(entry => [identity(entry.namespace, entry.key), entry])).values()]
  const changedIds = new Set([
    ...puts.map(entry => entry.resourceId),
    ...moves.map(move => entries.get(identity(move.namespace, move.fromKey))!.resourceId),
    ...directDeletes.map(entry => entries.get(identity(entry.namespace, entry.key))!.resourceId),
  ])
  if (puts.length + directDeletes.length + moves.length + aliasPuts.length + uniqueAliasDeletes.length === 0) {
    return { mode: 'active', before, mutation, review: null }
  }
  const change = validateConfigurationChange({
    ...CONFIGURATION_OPERATOR,
    authorityId: before.state.authorityId,
    expectedRevision: before.state.revision,
    operationId: resolved.randomUuid(),
    resourceId: changedIds.size === 1 ? [...changedIds][0]! : null,
    kind: 'lifecycle',
    expiresAt: new Date(resolved.now() + CONFIGURATION_LIMITS.REVIEW_TTL_MS).toISOString(),
    puts,
    deletes: directDeletes,
    moves,
    aliasPuts,
    aliasDeletes: uniqueAliasDeletes,
  })
  return {
    mode: 'active',
    before,
    mutation,
    review: await sealLifecycleReview(before, change),
  }
}

async function applyActivePlan(
  query: ConfigurationQuery,
  review: LifecycleConfigurationReview,
): Promise<ConfigurationReceipt> {
  try {
    return await acceptConfigurationChange(query, review.change)
  } catch (error) {
    try {
      const receipt = await readConfigurationReceipt(query, review.change.operationId, CONFIGURATION_OPERATOR)
      if (receipt) return receipt
    } catch {
      // Preserve the original outcome when receipt reconciliation is also unavailable
    }
    if (error instanceof ConfigurationError) throw error
    throw new ConfigurationError('unavailable', 'The D1 configuration write outcome is unverified; inspect provider state before retrying')
  }
}

export async function applyProviderConfiguration(
  plan: ProviderConfigurationPlan,
  dependencyInput: ProviderConfigurationDependencies = {},
): Promise<ConfigurationReceipt | null> {
  const resolved = dependencies(dependencyInput)
  if (plan.mode === 'active') {
    if (!plan.review) return null
    const query = dependencyInput.query ?? await operatorConfigurationQuery()
    return applyActivePlan(query, plan.review)
  }
  for (const put of plan.mutation.puts) {
    await resolved.putLegacy(put.namespace, put.key, put.value)
  }
  for (const deleted of plan.mutation.deletes) {
    await resolved.deleteLegacy(deleted.namespace, deleted.key)
  }
  const query = dependencyInput.query ?? await operatorConfigurationQuery()
  const observed = await readConfigurationState(query)
  if (observed.authorityId !== plan.before.state.authorityId || observed.revision !== plan.before.state.revision ||
      observed.mode !== plan.before.state.mode) {
    throw new ConfigurationError('conflict', 'Configuration authority changed during the legacy write; inspect provider state before retrying')
  }
  return null
}

export async function changeProviderConfiguration(
  mutation: ProviderConfigurationMutation,
  dependencyInput: ProviderConfigurationDependencies = {},
  progress?: ConfigurationProgress,
): Promise<ProviderConfigurationPlan> {
  const before = await readProviderConfiguration(dependencyInput, progress)
  const plan = await planProviderConfiguration(before, mutation, dependencyInput)
  await applyProviderConfiguration(plan, dependencyInput)
  return plan
}

export function providerConfigurationPlanSummary(plan: ProviderConfigurationPlan) {
  return {
    mode: plan.mode,
    authorityId: plan.before.state.authorityId,
    expectedRevision: plan.before.state.revision,
    puts: plan.mutation.puts.map(entry => ({ namespace: entry.namespace, key: entry.key })),
    deletes: plan.mutation.deletes.map(entry => ({ namespace: entry.namespace, key: entry.key })),
    rekeys: plan.mutation.rekeys.map(entry => ({
      namespace: entry.namespace,
      fromKey: entry.fromKey,
      toKey: entry.toKey,
      retainFromAlias: entry.retainFromAlias,
    })),
    aliasDeletes: plan.mutation.aliasDeletes.map(entry => ({ namespace: entry.namespace, key: entry.key })),
  }
}
