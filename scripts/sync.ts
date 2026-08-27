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
import { deleteRemoteKv, printableKvKey, putRemoteKv, readRemoteKvSnapshot } from './kv'
import { listWranglerSecrets } from './setup'

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
}

export function syncUsage(): string {
  return [
    'usage: pnpm sync [--routes <file>] [-y]',
    '',
    'options:',
    '  --routes <file>  read an explicit hash-only route configuration',
    '  -y, --yes  apply the remote KV plan',
    '  -h, --help show this help',
  ].join('\n')
}

export function parseSyncArgs(argv: string[]): SyncOptions {
  let routes: string | undefined
  let yes = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--routes') {
      if (routes !== undefined) throw new Error('--routes may only be supplied once')
      const value = argv[index + 1]
      if (!value || value.startsWith('-')) throw new Error('--routes requires a value')
      routes = value
      index += 1
    }
    else if (arg === '--help' || arg === '-h') throw new Error(syncUsage())
    else throw new Error(`unknown option: ${arg}`)
  }
  return { ...(routes ? { routes } : {}), yes }
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
  const { routes: routesOption, yes } = parseSyncArgs(argv)
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

  const current: KvSnapshot = await readRemoteKvSnapshot()
  const plan = computePlan(routes, current)

  console.log('Plan:')
  for (const p of plan.subPuts) console.log(`  PUT    ${printableKvKey(p.key)}`)
  for (const k of plan.subDeletes) console.log(`  DELETE ${printableKvKey(k)}`)
  for (const p of plan.sinkPuts) console.log(`  PUT    ${p.key}`)
  for (const k of plan.sinkDeletes) console.log(`  DELETE ${k}`)
  if (plan.subPuts.length === 0 && plan.subDeletes.length === 0 && plan.sinkPuts.length === 0 && plan.sinkDeletes.length === 0) {
    console.log('  (no changes)')
    return
  }

  if (!yes) {
    console.log('\nRe-run with -y to apply.')
    return
  }

  for (const { key, value } of plan.subPuts) await putRemoteKv('SUBS', key, value)
  for (const k of plan.subDeletes) await deleteRemoteKv('SUBS', k)
  for (const { key, value } of plan.sinkPuts) await putRemoteKv('SINKS', key, value)
  for (const k of plan.sinkDeletes) await deleteRemoteKv('SINKS', k)
  console.log('Applied.')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
