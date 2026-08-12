import { parse as parseJsonc, ParseError } from 'jsonc-parser'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  SUBSCRIPTION_HASH_RE,
  SUBSCRIPTION_KEY_PREFIX,
  subscriptionKvKey,
} from '../src/lib/subscription'
import { KNOWN_SOURCE_TYPES } from './subscription-sources'
import { parseGitHubEventSelection } from './github-events'

const execFileP = promisify(execFile)

const subSchema = z
  .object({
    name: z.string().min(1),
    source: z.string().min(1),
    slugHash: z.string().regex(SUBSCRIPTION_HASH_RE),
    enabled: z.boolean(),
    sinks: z.array(z.string().min(1)),
    auth: z
      .object({
        scheme: z.string().min(1),
        secretEnv: z.string().min(1),
      })
      .nullable()
      .optional()
      .default(null),
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

const sinkSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
  })
  .passthrough()

const routesSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    subs: z.array(subSchema),
    sinks: z.array(sinkSchema),
  })
  .strict()

export type Routes = z.infer<typeof routesSchema>
export type Sub = z.infer<typeof subSchema>
export type SinkRef = z.infer<typeof sinkSchema>

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
  const declaredSinkNames = new Set(routes.sinks.map((s) => s.name))
  const slugHashOwners = new Map<string, string>() // hash -> first sub.name to claim it

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
    for (const sinkName of sub.sinks) {
      if (!declaredSinkNames.has(sinkName)) {
        issues.push(`sub '${sub.name}': sink '${sinkName}' not declared in sinks[]`)
      }
    }
    if (sub.auth && !ctx.secretsAvailable.has(sub.auth.secretEnv)) {
      issues.push(`sub '${sub.name}': secret ${sub.auth.secretEnv} not set in Wrangler`)
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

  for (const sink of routes.sinks) {
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

export function printableKvKey(key: string): string {
  if (key.startsWith('sub:') && !key.startsWith(SUBSCRIPTION_KEY_PREFIX)) {
    return 'sub:<legacy-redacted>'
  }
  return key
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
  for (const sub of routes.subs) {
    const key = subscriptionKvKey(sub.slugHash)
    desiredSubKeys.add(key)
    const value = canonicalize({
      name: sub.name,
      source: sub.source,
      enabled: sub.enabled,
      sinks: sub.sinks,
      auth: sub.auth ?? null,
    })
    const existing = current.subs[key]
    const existingCanon = existing != null ? canonicalizeJson(existing) : null
    if (existingCanon !== value) subPuts.push({ key, value })
  }
  for (const key of Object.keys(current.subs)) {
    if (!desiredSubKeys.has(key)) subDeletes.push(key)
  }

  const desiredSinkKeys = new Set<string>()
  for (const sink of routes.sinks) {
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

// CLI -- only runs when invoked directly; importable functions stay pure for tests
// All KV ops pass --remote: sync targets the deployed Worker's production namespaces
// Without it, wrangler 4 defaults to the local Miniflare KV, so the live Worker would
// read nothing and every hook would 404
async function listKv(binding: string): Promise<Record<string, string>> {
  const { stdout: keysOut } = await execFileP('npx', ['wrangler', 'kv', 'key', 'list', '--binding', binding, '--remote'])
  const keys = JSON.parse(keysOut) as Array<{ name: string }>
  const out: Record<string, string> = {}
  for (const { name } of keys) {
    if (binding === 'SUBS' && name.startsWith('sub:') && !name.startsWith(SUBSCRIPTION_KEY_PREFIX)) {
      out[name] = ''
      continue
    }
    const { stdout } = await execFileP('npx', ['wrangler', 'kv', 'key', 'get', name, '--binding', binding, '--text', '--remote'])
    out[name] = stdout
  }
  return out
}

async function putKv(binding: string, key: string, value: string): Promise<void> {
  await execFileP('npx', ['wrangler', 'kv', 'key', 'put', key, value, '--binding', binding, '--remote'])
}

async function deleteKv(binding: string, key: string): Promise<void> {
  try {
    await execFileP('npx', ['wrangler', 'kv', 'key', 'delete', key, '--binding', binding, '--remote'])
  } catch {
    throw new Error(`KV delete failed for ${printableKvKey(key)} in ${binding}`)
  }
}

async function listSecrets(): Promise<Set<string>> {
  const { stdout } = await execFileP('npx', ['wrangler', 'secret', 'list'])
  // wrangler outputs JSON of [{ name, type }, ...]
  const items = JSON.parse(stdout) as Array<{ name: string }>
  return new Set(items.map((i) => i.name))
}

async function main() {
  const yes = process.argv.includes('--yes')
  const path = resolve('routes.jsonc')
  const text = await readFile(path, 'utf8')
  const routes = parseRoutes(text)

  const knownSources = new Set<string>(KNOWN_SOURCE_TYPES)
  const knownSinkTypes = new Set(['ntfy', 'discord'])
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
  }
  const secretsAvailable = await listSecrets()

  const issues = validateRoutes(routes, { knownSources, knownSinkTypes, sinkSchemas, secretsAvailable })
  if (issues.length) {
    console.error('Validation issues:\n' + issues.map((i) => `  - ${i}`).join('\n'))
    process.exit(1)
  }

  const current: KvSnapshot = {
    subs: await listKv('SUBS'),
    sinks: await listKv('SINKS'),
  }
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
    console.log('\nRe-run with --yes to apply.')
    return
  }

  for (const { key, value } of plan.subPuts) await putKv('SUBS', key, value)
  for (const k of plan.subDeletes) await deleteKv('SUBS', k)
  for (const { key, value } of plan.sinkPuts) await putKv('SINKS', key, value)
  for (const k of plan.sinkDeletes) await deleteKv('SINKS', k)
  console.log('Applied.')
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
