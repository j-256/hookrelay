import { parse as parseJsonc, ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  SUBSCRIPTION_HASH_RE,
  SUBSCRIPTION_KEY_PREFIX,
  subscriptionKvKey,
} from '../src/lib/subscription'
import {
  EMAIL_SOURCE,
  normalizeEmailBaseAddress,
  normalizeSenderRule,
} from '../src/lib/email-address'
import { normalizeEmailLinkLabel } from '../src/lib/email-links'
import { EVENT_TYPE_FILTER_PATTERN_RE } from '../src/lib/event-filter'
import { normalizeFallbackUrl } from '../src/lib/public-url'
import {
  OPERATIONS_CONFIG_KEY,
  OPERATIONS_FALLBACK_PREFIX,
  RETENTION_CONFIG_KEY,
} from '../src/lib/runtime-config'
import { SEVERITIES } from '../src/types'
import { getSourceProfile, KNOWN_SOURCE_TYPES } from './subscription-sources'
import { githubEventTypeFilter, parseGitHubEventSelection } from './providers/github/event-profiles'
import { printableKvKey } from './kv'
import { listWranglerSecrets, PROVIDER_SYNC_SCOPE_ENV } from './setup'
import {
  applyProviderConfiguration,
  planProviderConfiguration,
  providerConfigurationPlanSummary,
  readProviderConfiguration,
  type ProviderConfigurationMutation,
  type ProviderConfigurationSnapshot,
} from './provider-configuration'

export { printableKvKey } from './kv'

const eventTypePatternSchema = z.string().regex(EVENT_TYPE_FILTER_PATTERN_RE)

const eventTypeFilterSchema = z
  .object({
    include: z.array(eventTypePatternSchema).min(1).optional(),
    exclude: z.array(eventTypePatternSchema).min(1).optional(),
  })
  .strict()
  .refine((filter) => filter.include !== undefined || filter.exclude !== undefined, {
    message: 'eventTypes requires include or exclude',
  })

const severityFilterSchema = z
  .object({
    include: z.array(z.enum(SEVERITIES)).min(1).optional(),
    exclude: z.array(z.enum(SEVERITIES)).min(1).optional(),
  })
  .strict()
  .refine((filter) => filter.include !== undefined || filter.exclude !== undefined, {
    message: 'severities requires include or exclude',
  })

const eventFilterSchema = z
  .object({
    eventTypes: eventTypeFilterSchema.optional(),
    severities: severityFilterSchema.optional(),
  })
  .strict()
  .refine((filter) => filter.eventTypes !== undefined || filter.severities !== undefined, {
    message: 'filter requires eventTypes or severities',
  })

export const subSchema = z
  .object({
    name: z.string().min(1),
    source: z.string().min(1),
    slugHash: z.string().regex(SUBSCRIPTION_HASH_RE),
    enabled: z.boolean(),
    sinks: z.array(z.string().min(1)),
    fallbackUrl: z.string().min(1).optional(),
    auth: z
      .object({
        scheme: z.string().min(1),
        secretEnv: z.string().min(1),
        alternateSecretEnvs: z.array(z.string().min(1)).min(1).optional(),
      })
      .nullable()
      .optional()
      .default(null),
    email: z
      .object({
        allowedSenders: z.array(z.string().min(1)).default([]),
        primaryLinkLabels: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .optional(),
    filter: eventFilterSchema.optional(),
    sinkFilters: z.record(z.string().min(1), eventFilterSchema).optional(),
    setup: z
      .object({
        github: z
          .object({
            repo: z.string().min(1),
            eventProfiles: z.array(z.string().min(1)).min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const sinkSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
  })
  .passthrough()

const operationsSchema = z
  .object({
    sinks: z.array(z.string().min(1)).min(1),
    alertCooldownMinutes: z.number().int().positive(),
    staleDeliveryMinutes: z.number().int().positive(),
  })
  .strict()

const retentionSchema = z
  .object({
    r2Days: z.number().int().positive().optional(),
    d1Days: z.number().int().positive().optional(),
  })
  .strict()
  .refine((retention) => retention.r2Days !== undefined || retention.d1Days !== undefined, {
    message: 'retention requires r2Days or d1Days',
  })

const routesSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    emailBaseAddress: z.string().min(1).optional(),
    operations: operationsSchema.optional(),
    retention: retentionSchema.optional(),
    subs: z.array(subSchema),
    sinks: z.array(sinkSchema),
    retiredSinks: z.array(sinkSchema).optional(),
  })
  .strict()

export type Routes = z.infer<typeof routesSchema>
export type Sub = z.infer<typeof subSchema>
export type SinkRef = z.infer<typeof sinkSchema>

export interface SyncOptions {
  routes?: string
  yes: boolean
  putSubscriptions?: string[]
  putSinks?: string[]
  putRetention?: boolean
  putOperations?: boolean
}

export const SUBSCRIPTION_POLICY_FIELDS = Object.freeze(['enabled', 'sinks', 'filter', 'sinkFilters'] as const)
export type SubscriptionPolicyField = typeof SUBSCRIPTION_POLICY_FIELDS[number]

const syncScopeKeySchema = z.object({
  namespace: z.enum(['SUBS', 'SINKS']),
  key: z.string().min(1).max(240),
}).strict()
const syncScopePutSchema = syncScopeKeySchema.extend({
  policyFields: z.array(z.enum(SUBSCRIPTION_POLICY_FIELDS)).min(1).optional(),
  policySourceKey: z.string().min(1).max(240).optional(),
}).strict()
const syncScopeRekeySchema = z.object({
  namespace: z.enum(['SUBS', 'SINKS']),
  fromKey: z.string().min(1).max(240),
  toKey: z.string().min(1).max(240),
  retainFromAlias: z.boolean(),
  replaceTarget: z.boolean().optional(),
  allowMissingSourceIfTarget: z.boolean().optional(),
}).strict()
const providerSyncScopeSchema = z.object({
  puts: z.array(syncScopePutSchema).default([]),
  deletes: z.array(syncScopeKeySchema).default([]),
  rekeys: z.array(syncScopeRekeySchema).default([]),
  aliasDeletes: z.array(syncScopeKeySchema).default([]),
}).strict().superRefine((scope, context) => {
  if (scope.puts.length + scope.deletes.length + scope.rekeys.length + scope.aliasDeletes.length === 0) {
    context.addIssue({ code: 'custom', message: 'provider sync scope has no changes' })
  }
  for (const put of scope.puts) {
    if (put.namespace !== 'SUBS' && (put.policyFields || put.policySourceKey)) {
      context.addIssue({ code: 'custom', message: 'policy selection applies only to subscriptions' })
    }
    if (put.policyFields && new Set(put.policyFields).size !== put.policyFields.length) {
      context.addIssue({ code: 'custom', message: 'policy field is selected more than once' })
    }
    if (put.policySourceKey && !put.policyFields) {
      context.addIssue({ code: 'custom', message: 'a policy source requires selected policy fields' })
    }
  }
})
export interface ProviderSyncScopePut {
  namespace: 'SUBS' | 'SINKS'
  key: string
  policyFields?: readonly SubscriptionPolicyField[]
  policySourceKey?: string
}
export interface ProviderSyncScopeKey {
  namespace: 'SUBS' | 'SINKS'
  key: string
}
export interface ProviderSyncScopeRekey {
  namespace: 'SUBS' | 'SINKS'
  fromKey: string
  toKey: string
  retainFromAlias: boolean
  replaceTarget?: boolean
  allowMissingSourceIfTarget?: boolean
}
export interface ProviderSyncScope {
  puts?: readonly ProviderSyncScopePut[]
  deletes?: readonly ProviderSyncScopeKey[]
  rekeys?: readonly ProviderSyncScopeRekey[]
  aliasDeletes?: readonly ProviderSyncScopeKey[]
}

export function syncUsage(): string {
  return [
    'usage: pnpm sync [--routes <file>] [-y]',
    '',
    'options:',
    '  -r, --routes <file>  read an explicit hash-only route configuration',
    '      --put-sub <name> apply one local subscription, repeatable',
    '      --put-sink <name> apply one local sink, repeatable',
    '      --put-retention  apply config:retention only',
    '      --put-operations apply config:operations only',
    '  -y, --yes            apply the plan (exact scope required in active mode)',
    '  -h, --help           show this help',
  ].join('\n')
}

export function parseSyncArgs(argv: string[]): SyncOptions {
  let routes: string | undefined
  const putSubscriptions: string[] = []
  const putSinks: string[] = []
  let putRetention = false
  let putOperations = false
  let yes = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--routes' || arg === '-r') {
      if (routes !== undefined) throw new Error('--routes may only be supplied once')
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error('--routes requires a value')
      routes = value
      index += 1
    }
    else if (arg === '--put-sub' || arg === '--put-sink') {
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`)
      const selected = arg === '--put-sub' ? putSubscriptions : putSinks
      if (selected.includes(value)) throw new Error(`${arg} may not select the same name more than once`)
      selected.push(value)
      index += 1
    }
    else if (arg === '--put-retention' || arg === '--put-operations') {
      if (arg === '--put-retention') {
        if (putRetention) throw new Error('--put-retention may only be supplied once')
        putRetention = true
      } else {
        if (putOperations) throw new Error('--put-operations may only be supplied once')
        putOperations = true
      }
    }
    else if (arg === '--help' || arg === '-h') throw new Error(syncUsage())
    else throw new Error(`unknown option: ${arg}`)
  }
  return {
    ...(routes ? { routes } : {}),
    yes,
    ...(putSubscriptions.length ? { putSubscriptions } : {}),
    ...(putSinks.length ? { putSinks } : {}),
    ...(putRetention ? { putRetention } : {}),
    ...(putOperations ? { putOperations } : {}),
  }
}

export function parseRoutes(text: string): Routes {
  const errs: ParseError[] = []
  const parsed = parseJsonc(text, errs, { allowTrailingComma: true })
  if (errs.length) {
    const lines = errs.map((e) => `  line offset ${e.offset}: error code ${e.error}`).join('\n')
    throw new Error(`failed to parse routes: jsonc errors\n${lines}`)
  }
  return routesSchema.parse(parsed)
}

export interface ValidateContext {
  knownSources: Set<string>
  knownSinkTypes: Set<string>
  sinkSchemas: Record<string, z.ZodType>
  secretsAvailable: Set<string>
}

export function validateRoutes(routes: Routes, ctx: ValidateContext): string[] {
  const issues: string[] = []
  const activeSinkNames = new Set(routes.sinks.map((sink) => sink.name))
  const retiredSinkNames = new Set((routes.retiredSinks ?? []).map((sink) => sink.name))
  const declaredSinkNames = new Set([...activeSinkNames, ...retiredSinkNames])
  const slugHashOwners = new Map<string, string>() // hash -> first sub.name to claim it
  let normalizedEmailBaseAddress: string | undefined

  for (const sink of routes.sinks) {
    if (retiredSinkNames.has(sink.name)) issues.push(`sink '${sink.name}': declared as both active and retired`)
  }
  for (const collection of [routes.sinks, routes.retiredSinks ?? []]) {
    const names = new Set<string>()
    for (const sink of collection) {
      if (names.has(sink.name)) issues.push(`sink '${sink.name}': declared more than once`)
      names.add(sink.name)
    }
  }

  if (routes.operations) {
    const operationSinks = new Set<string>()
    for (const sinkName of routes.operations.sinks) {
      if (!activeSinkNames.has(sinkName)) {
        issues.push(`operations: unknown sink: ${sinkName}`)
      }
      if (operationSinks.has(sinkName)) {
        issues.push(`operations: duplicate sink: ${sinkName}`)
      }
      operationSinks.add(sinkName)
    }
  }

  if (routes.emailBaseAddress) {
    try {
      normalizedEmailBaseAddress = normalizeEmailBaseAddress(routes.emailBaseAddress)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      issues.push(`emailBaseAddress is invalid: ${message}`)
    }
  }

  for (const sub of routes.subs) {
    const prevOwner = slugHashOwners.get(sub.slugHash)
    if (prevOwner !== undefined) {
      issues.push(`duplicate sub slugHash between '${prevOwner}' and '${sub.name}'`)
    } else {
      slugHashOwners.set(sub.slugHash, sub.name)
    }

    if (!ctx.knownSources.has(sub.source)) {
      issues.push(`sub '${sub.name}': unknown source: ${sub.source}`)
    }
    if (sub.fallbackUrl) {
      try {
        normalizeFallbackUrl(sub.fallbackUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        issues.push(`sub '${sub.name}': ${message}`)
      }
    }
    if (sub.source === EMAIL_SOURCE) {
      if (!sub.email) {
        issues.push(`sub '${sub.name}': email subscriptions require email configuration`)
      }
      if (!normalizedEmailBaseAddress) {
        issues.push(`sub '${sub.name}': email subscriptions require emailBaseAddress`)
      }
      if (sub.auth) {
        issues.push(`sub '${sub.name}': email subscriptions do not use auth configuration`)
      }
      const normalizedRules = new Set<string>()
      for (const rule of sub.email?.allowedSenders ?? []) {
        try {
          const normalized = normalizeSenderRule(rule)
          if (normalizedRules.has(normalized)) {
            issues.push(`sub '${sub.name}': duplicate email sender rule: ${rule}`)
          }
          normalizedRules.add(normalized)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          issues.push(`sub '${sub.name}': ${message}`)
        }
      }
      const normalizedLinkLabels = new Set<string>()
      for (const label of sub.email?.primaryLinkLabels ?? []) {
        try {
          const normalized = normalizeEmailLinkLabel(label)
          if (normalizedLinkLabels.has(normalized)) {
            issues.push(`sub '${sub.name}': duplicate email primary link label: ${label}`)
          }
          normalizedLinkLabels.add(normalized)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          issues.push(`sub '${sub.name}': ${message}`)
        }
      }
    } else if (sub.email) {
      issues.push(`sub '${sub.name}': email configuration is only valid for email subscriptions`)
    }
    if (new Set(sub.sinks).size !== sub.sinks.length) {
      issues.push(`sub '${sub.name}': duplicate sink reference`)
    }
    const namedFilters = [
      ['subscription', sub.filter] as const,
      ...Object.entries(sub.sinkFilters ?? {}).map(([sinkName, filter]) => [
        `sink '${sinkName}'`,
        filter,
      ] as const),
    ]
    for (const [label, filter] of namedFilters) {
      for (const [mode, patterns] of Object.entries(filter?.eventTypes ?? {})) {
        if (patterns && new Set(patterns).size !== patterns.length) {
          issues.push(`sub '${sub.name}' ${label}: duplicate event type ${mode} pattern`)
        }
      }
      for (const [mode, severities] of Object.entries(filter?.severities ?? {})) {
        if (severities && new Set(severities).size !== severities.length) {
          issues.push(`sub '${sub.name}' ${label}: duplicate severity ${mode} value`)
        }
      }
    }
    for (const sinkName of Object.keys(sub.sinkFilters ?? {})) {
      if (!sub.sinks.includes(sinkName)) {
        issues.push(`sub '${sub.name}': sink filter '${sinkName}' is not listed in sinks[]`)
      }
    }
    for (const sinkName of sub.sinks) {
      if (!declaredSinkNames.has(sinkName)) {
        issues.push(`sub '${sub.name}': sink '${sinkName}' not declared in sinks[] or retiredSinks[]`)
      } else if (sub.enabled && !activeSinkNames.has(sinkName)) {
        issues.push(`sub '${sub.name}': enabled subscriptions cannot reference retired sink '${sinkName}'`)
      }
    }
    if (sub.auth) {
      const secretEnvs = [sub.auth.secretEnv, ...(sub.auth.alternateSecretEnvs ?? [])]
      for (const name of secretEnvs) {
        if (!ctx.secretsAvailable.has(name)) {
          issues.push(`sub '${sub.name}': secret ${name} not set in Wrangler`)
        }
      }
      if (new Set(secretEnvs).size !== secretEnvs.length) {
        issues.push(`sub '${sub.name}': auth secret references must be unique`)
      }
    }
    const sourceProfile = getSourceProfile(sub.source)
    if (sourceProfile?.senderAuth) {
      if (!sub.auth) {
        issues.push(`sub '${sub.name}': ${sub.source} subscriptions require auth configuration`)
      } else if (sub.auth.scheme !== sourceProfile.senderAuth.scheme) {
        issues.push(`sub '${sub.name}': ${sub.source} subscriptions require the ${sourceProfile.senderAuth.scheme} scheme`)
      }
    }
    if (sub.auth?.alternateSecretEnvs) {
      if (sub.source !== 'github' && sub.source !== 'cloudevents') {
        issues.push(`sub '${sub.name}': alternateSecretEnvs is only valid for rotating HMAC subscriptions`)
      }
      if (sub.auth.scheme !== 'github-sha256' && sub.auth.scheme !== 'hookrelay-sha256') {
        issues.push(`sub '${sub.name}': alternateSecretEnvs requires an HMAC-SHA256 scheme`)
      }
    }
    if (sub.setup?.github) {
      if (sub.source !== 'github') {
        issues.push(`sub '${sub.name}': setup.github is only valid for GitHub subscriptions`)
      } else {
        try {
          parseGitHubEventSelection(sub.setup.github.eventProfiles.join(','))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          issues.push(`sub '${sub.name}': invalid setup.github.eventProfiles: ${message}`)
        }
      }
    }
  }

  for (const sink of [...routes.sinks, ...(routes.retiredSinks ?? [])]) {
    if (!ctx.knownSinkTypes.has(sink.type)) {
      issues.push(`sink '${sink.name}': unknown sink type: ${sink.type}`)
      continue
    }
    const schema = ctx.sinkSchemas[sink.type]
    if (schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function') {
      const parsed = schema.safeParse(sink)
      if (!parsed.success) {
        issues.push(`sink '${sink.name}': config invalid -- ${parsed.error.message}`)
      }
    }
    // Additionally, for any *Env reference, ensure the secret exists
    for (const [k, v] of Object.entries(sink)) {
      if (k.endsWith('Env') && typeof v === 'string' && !ctx.secretsAvailable.has(v)) {
        issues.push(`sink '${sink.name}': secret ${v} (referenced via ${k}) not set in Wrangler`)
      }
    }
  }

  return issues
}

export interface KvSnapshot {
  subs: Record<string, string>
  sinks: Record<string, string>
}

export interface PutEntry {
  key: string
  value: string
}

export interface Plan {
  subPuts: PutEntry[]
  subDeletes: string[]
  sinkPuts: PutEntry[]
  sinkDeletes: string[]
}

export interface ProviderRetirementUpdate {
  namespace: 'SUBS' | 'SINKS'
  key: string
  retired: boolean
}

export interface ProviderComparisonPlan extends Plan {
  retirementUpdates: ProviderRetirementUpdate[]
}

function canonicalize(value: unknown): string {
  // Deterministic JSON: sort object keys recursively so unchanged data round-trips identically
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value as object).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`
}

function canonicalizeJson(text: string): string | null {
  // Re-canonicalize an existing KV value so key order doesn't trigger spurious puts
  try {
    return canonicalize(JSON.parse(text))
  } catch {
    return null
  }
}

function desiredSnapshot(routes: Routes): KvSnapshot {
  const plan = computePlan(routes, { subs: {}, sinks: {} })
  return {
    subs: Object.fromEntries(plan.subPuts.map(entry => [entry.key, entry.value])),
    sinks: Object.fromEntries(plan.sinkPuts.map(entry => [entry.key, entry.value])),
  }
}

function canonicalProviderSnapshot(current: ProviderConfigurationSnapshot): KvSnapshot {
  const subs: Record<string, string> = {}
  const sinks: Record<string, string> = {}
  for (const entry of current.entries) {
    (entry.namespace === 'SUBS' ? subs : sinks)[entry.key] = entry.value
  }
  return { subs, sinks }
}

export function computeProviderComparisonPlan(
  routes: Routes,
  current: ProviderConfigurationSnapshot,
): ProviderComparisonPlan {
  const plan = computePlan(
    routes,
    current.state.mode === 'active' ? canonicalProviderSnapshot(current) : current,
  )
  if (current.state.mode !== 'active') return { ...plan, retirementUpdates: [] }
  const desired = desiredSnapshot(routes)
  const retirementUpdates = current.entries.flatMap(entry => {
    const values = entry.namespace === 'SUBS' ? desired.subs : desired.sinks
    if (values[entry.key] === undefined) return []
    const retired = desiredRetired(routes, entry.namespace, entry.key)
    return entry.retired === retired ? [] : [{ namespace: entry.namespace, key: entry.key, retired }]
  })
  return { ...plan, retirementUpdates }
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error(`${label} has invalid provider configuration`)
  }
}

export function mergeSubscriptionPolicy(
  current: string,
  desired: string,
  selected: readonly SubscriptionPolicyField[] | undefined,
): string {
  const before = parseObject(current, 'The active subscription')
  const after = parseObject(desired, 'The local subscription')
  const fields = new Set(selected ?? [])
  for (const field of SUBSCRIPTION_POLICY_FIELDS) {
    if (fields.has(field)) continue
    if (Object.hasOwn(before, field)) after[field] = before[field]
    else delete after[field]
  }
  return canonicalize(after)
}

function desiredRetired(routes: Routes, namespace: 'SUBS' | 'SINKS', key: string): boolean {
  if (namespace === 'SUBS') return false
  return (routes.retiredSinks ?? []).some(sink => `sink:${sink.name}` === key)
}

export function parseProviderSyncScope(value: string): Required<ProviderSyncScope> {
  try {
    return providerSyncScopeSchema.parse(JSON.parse(value))
  } catch {
    throw new Error('The internal provider sync scope is invalid')
  }
}

export function scopedProviderMutation(
  routes: Routes,
  current: ProviderConfigurationSnapshot,
  input: ProviderSyncScope,
): ProviderConfigurationMutation {
  const scope = providerSyncScopeSchema.parse(input)
  const desired = desiredSnapshot(routes)
  const puts = scope.puts.map(selected => {
    const values = selected.namespace === 'SUBS' ? desired.subs : desired.sinks
    const value = values[selected.key]
    if (value === undefined) throw new Error(`Selected provider key is missing from routes.jsonc: ${printableKvKey(selected.key)}`)
    const currentValues = selected.namespace === 'SUBS' ? current.subs : current.sinks
    const policySource = current.entries.find(entry => (
      entry.namespace === selected.namespace && entry.key === (selected.policySourceKey ?? selected.key)
    )) ?? current.entries.find(entry => entry.namespace === selected.namespace && entry.key === selected.key)
    const merged = current.state.mode === 'active' && selected.namespace === 'SUBS' && policySource
      ? mergeSubscriptionPolicy(currentValues[policySource.key]!, value, selected.policyFields)
      : value
    return {
      namespace: selected.namespace,
      key: selected.key,
      value: merged,
      retired: desiredRetired(routes, selected.namespace, selected.key),
    }
  })
  return {
    puts,
    deletes: scope.deletes,
    rekeys: current.state.mode === 'active' ? scope.rekeys : [],
    aliasDeletes: current.state.mode === 'active' ? scope.aliasDeletes : [],
  }
}

export function providerSyncScopeForOptions(routes: Routes, options: SyncOptions): ProviderSyncScope | null {
  const puts: ProviderSyncScopePut[] = []
  const deletes: ProviderSyncScopeKey[] = []
  for (const name of options.putSubscriptions ?? []) {
    const matches = routes.subs.filter(subscription => subscription.name === name)
    if (matches.length !== 1) throw new Error(`Selected subscription must exist exactly once in routes.jsonc: ${name}`)
    puts.push({
      namespace: 'SUBS',
      key: subscriptionKvKey(matches[0]!.slugHash),
      policyFields: SUBSCRIPTION_POLICY_FIELDS,
    })
  }
  for (const name of options.putSinks ?? []) {
    const matches = [...routes.sinks, ...(routes.retiredSinks ?? [])].filter(sink => sink.name === name)
    if (matches.length !== 1) throw new Error(`Selected sink must exist exactly once in routes.jsonc: ${name}`)
    puts.push({ namespace: 'SINKS', key: `sink:${name}` })
  }
  if (options.putRetention) {
    if (routes.retention) puts.push({ namespace: 'SUBS', key: RETENTION_CONFIG_KEY })
    else deletes.push({ namespace: 'SUBS', key: RETENTION_CONFIG_KEY })
  }
  if (options.putOperations) {
    if (routes.operations) puts.push({ namespace: 'SUBS', key: OPERATIONS_CONFIG_KEY })
    else deletes.push({ namespace: 'SUBS', key: OPERATIONS_CONFIG_KEY })
  }
  return puts.length + deletes.length ? { puts, deletes } : null
}

export function computePlan(routes: Routes, current: KvSnapshot): Plan {
  const subPuts: PutEntry[] = []
  const subDeletes: string[] = []
  const sinkPuts: PutEntry[] = []
  const sinkDeletes: string[] = []

  const desiredSubKeys = new Set<string>()
  if (routes.operations) {
    desiredSubKeys.add(OPERATIONS_CONFIG_KEY)
    const value = canonicalize(routes.operations)
    const existing = current.subs[OPERATIONS_CONFIG_KEY]
    if ((existing == null ? null : canonicalizeJson(existing)) !== value) {
      subPuts.push({ key: OPERATIONS_CONFIG_KEY, value })
    }
  }
  if (routes.retention) {
    desiredSubKeys.add(RETENTION_CONFIG_KEY)
    const value = canonicalize(routes.retention)
    const existing = current.subs[RETENTION_CONFIG_KEY]
    if ((existing == null ? null : canonicalizeJson(existing)) !== value) {
      subPuts.push({ key: RETENTION_CONFIG_KEY, value })
    }
  }
  for (const sub of routes.subs) {
    const key = subscriptionKvKey(sub.slugHash)
    desiredSubKeys.add(key)
    const githubFilter = sub.setup?.github
      ? githubEventTypeFilter(parseGitHubEventSelection(sub.setup.github.eventProfiles.join(',')))
      : undefined
    const runtimeFilter = sub.filter ?? githubFilter
    const value = canonicalize({
      name: sub.name,
      source: sub.source,
      enabled: sub.enabled,
      sinks: sub.sinks,
      auth: sub.auth ?? null,
      ...(sub.fallbackUrl ? { fallbackUrl: normalizeFallbackUrl(sub.fallbackUrl) } : {}),
      ...(sub.email
        ? {
            email: {
              allowedSenders: sub.email.allowedSenders,
              primaryLinkLabels: sub.email.primaryLinkLabels.map(normalizeEmailLinkLabel),
            },
          }
        : {}),
      ...(runtimeFilter ? { filter: runtimeFilter } : {}),
      ...(sub.sinkFilters ? { sinkFilters: sub.sinkFilters } : {}),
    })
    const existing = current.subs[key]
    const existingCanon = existing != null ? canonicalizeJson(existing) : null
    if (existingCanon !== value) subPuts.push({ key, value })
  }
  for (const key of Object.keys(current.subs)) {
    if (key.startsWith(OPERATIONS_FALLBACK_PREFIX)) continue
    if (!desiredSubKeys.has(key)) subDeletes.push(key)
  }

  const desiredSinkKeys = new Set<string>()
  for (const sink of [...routes.sinks, ...(routes.retiredSinks ?? [])]) {
    const key = `sink:${sink.name}`
    desiredSinkKeys.add(key)
    const { name: _name, ...rest } = sink
    const value = canonicalize(rest)
    const existing = current.sinks[key]
    const existingCanon = existing != null ? canonicalizeJson(existing) : null
    if (existingCanon !== value) sinkPuts.push({ key, value })
  }
  for (const key of Object.keys(current.sinks)) {
    if (!desiredSinkKeys.has(key)) sinkDeletes.push(key)
  }

  return { subPuts, subDeletes, sinkPuts, sinkDeletes }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(syncUsage())
    return
  }
  const options = parseSyncArgs(argv)
  const { routes: routesOption, yes } = options
  const routesPath = resolve(routesOption ?? 'routes.jsonc')
  const text = await readFile(routesPath, 'utf8')
  const routes = parseRoutes(text)

  const knownSources = new Set<string>(KNOWN_SOURCE_TYPES)
  const knownSinkTypes = new Set(['ntfy', 'discord', 'webhook'])
  const sinkSchemas = {
    ntfy: z
      .object({
        name: z.string(),
        type: z.literal('ntfy'),
        topic: z.string(),
        server: z.string().url().optional(),
        tokenEnv: z.string().min(1).optional(),
      })
      .strict(),
    discord: z.object({ name: z.string(), type: z.literal('discord'), urlEnv: z.string() }).strict(),
    webhook: z
      .object({
        name: z.string(),
        type: z.literal('webhook'),
        urlEnv: z.string().min(1),
        signingSecretEnv: z.string().min(1),
      })
      .strict(),
  }
  const secretsAvailable = await listWranglerSecrets()

  const issues = validateRoutes(routes, { knownSources, knownSinkTypes, sinkSchemas, secretsAvailable })
  if (issues.length) {
    console.error('Validation issues:\n' + issues.map((i) => `  - ${i}`).join('\n'))
    process.exit(1)
  }

  const current = await readProviderConfiguration()
  const encodedScope = process.env[PROVIDER_SYNC_SCOPE_ENV]
  if (encodedScope && (options.putSubscriptions || options.putSinks || options.putRetention || options.putOperations)) {
    throw new Error('Do not combine an internal provider scope with command-line selectors')
  }
  const scope = encodedScope ? parseProviderSyncScope(encodedScope) : providerSyncScopeForOptions(routes, options)
  const plan = scope
    ? await planProviderConfiguration(current, scopedProviderMutation(routes, current, scope))
    : null
  const fullPlan = scope ? null : computeProviderComparisonPlan(routes, current)
  const summary = plan ? providerConfigurationPlanSummary(plan) : null

  console.log(`Plan (${current.state.mode} authority at revision ${current.state.revision}):`)
  if (summary) {
    for (const entry of summary.puts) console.log(`  PUT    ${printableKvKey(entry.key)}`)
    for (const entry of summary.deletes) console.log(`  DELETE ${printableKvKey(entry.key)}`)
    for (const entry of summary.rekeys) {
      console.log(`  REKEY  ${printableKvKey(entry.fromKey)} -> ${printableKvKey(entry.toKey)}${entry.retainFromAlias ? ' (retain alias)' : ''}`)
    }
    for (const entry of summary.aliasDeletes) console.log(`  UNALIAS ${printableKvKey(entry.key)}`)
  } else if (fullPlan) {
    for (const p of fullPlan.subPuts) console.log(`  PUT    ${printableKvKey(p.key)}`)
    for (const k of fullPlan.subDeletes) console.log(`  DELETE ${printableKvKey(k)}`)
    for (const p of fullPlan.sinkPuts) console.log(`  PUT    ${p.key}`)
    for (const k of fullPlan.sinkDeletes) console.log(`  DELETE ${k}`)
    for (const update of fullPlan.retirementUpdates) {
      console.log(`  STATUS ${printableKvKey(update.key)} -> ${update.retired ? 'retired' : 'active'}`)
    }
  }
  const changed = summary?.changed ?? (fullPlan !== null && (
    fullPlan.subPuts.length + fullPlan.subDeletes.length + fullPlan.sinkPuts.length + fullPlan.sinkDeletes.length +
      fullPlan.retirementUpdates.length > 0
  ))
  if (!changed) {
    console.log('  (no changes)')
    return
  }

  if (!yes) {
    console.log('\nRe-run with -y to apply.')
    return
  }

  if (current.state.mode === 'active' && !scope) {
    throw new Error('Active D1 configuration requires an exact command scope; use the lifecycle command that owns this change')
  }
  const selectedPlan = plan ?? await planProviderConfiguration(current, {
    puts: [
      ...fullPlan!.subPuts.map(entry => ({ namespace: 'SUBS' as const, ...entry })),
      ...fullPlan!.sinkPuts.map(entry => ({ namespace: 'SINKS' as const, ...entry })),
    ],
    deletes: [
      ...fullPlan!.subDeletes.map(key => ({ namespace: 'SUBS' as const, key })),
      ...fullPlan!.sinkDeletes.map(key => ({ namespace: 'SINKS' as const, key })),
    ],
  })
  await applyProviderConfiguration(selectedPlan)
  console.log('Applied.')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
