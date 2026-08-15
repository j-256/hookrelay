import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { readFile } from 'node:fs/promises'
import { parseRoutes } from './sync'
import { confirm } from './setup'

export const MANAGED_RETENTION_RULE_ID = 'hookrelay-events-retention'
export const MANAGED_RETENTION_PREFIX = 'events/'

const SECONDS_PER_DAY = 24 * 60 * 60

export type RetentionPhase = 'plan' | 'apply' | 'verify'

export interface RetentionOptions {
  phase: RetentionPhase
  yes: boolean
}

export interface LifecycleRule {
  id: string
  enabled: boolean
  conditions: { prefix?: string | null }
  deleteObjectsTransition?: {
    condition?: { type: string; maxAge?: number; date?: string }
  }
  [key: string]: unknown
}

export interface RetentionSettings {
  bucketName: string
  r2Days?: number
  d1Days?: number
}

export interface LifecyclePlan {
  bucketName: string
  r2Days?: number
  currentState: 'missing' | 'matches' | 'drifted' | 'unexpected'
  unrelatedRules: number
  changed: boolean
  desiredRules: LifecycleRule[]
}

export interface RetentionDependencies {
  fetch: typeof fetch
  readText(path: string): Promise<string>
  confirm(question: string): Promise<boolean>
  environment: Record<string, string | undefined>
  log(line: string): void
}

const DEFAULT_DEPENDENCIES: RetentionDependencies = {
  fetch,
  readText: (path) => readFile(path, 'utf8'),
  confirm,
  environment: process.env,
  log: console.log,
}

export function retentionUsage(): string {
  return [
    'usage: pnpm retention <plan|apply|verify> [-y]',
    '',
    'phases:',
    '  plan    Read the remote lifecycle and preview the managed rule',
    '  apply   Preserve unrelated rules and apply the managed rule',
    '  verify  Require the remote managed rule to match routes.jsonc',
    '',
    'options:',
    '  -y, --yes  Skip apply confirmation',
    '  -h, --help Show this help',
  ].join('\n')
}

export function parseRetentionArgs(argv: string[]): RetentionOptions {
  const phase = argv[0]
  if (phase !== 'plan' && phase !== 'apply' && phase !== 'verify') {
    throw new Error(retentionUsage())
  }
  let yes = false
  for (const argument of argv.slice(1)) {
    if (argument === '-y' || argument === '--yes') yes = true
    else throw new Error(`unknown option: ${argument}`)
  }
  if (yes && phase !== 'apply') throw new Error('-y is valid only for retention apply')
  return { phase, yes }
}

function parseJsoncObject(text: string, label: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not valid JSONC`)
  }
  return parsed as Record<string, unknown>
}

export function parseRetentionSettings(
  routesText: string,
  wranglerText: string,
): RetentionSettings {
  const routes = parseRoutes(routesText)
  const wrangler = parseJsoncObject(wranglerText, 'wrangler.jsonc')
  const buckets = wrangler.r2_buckets
  if (!Array.isArray(buckets)) throw new Error('wrangler.jsonc has no r2_buckets array')
  const matches = buckets.filter((entry) => (
    typeof entry === 'object' &&
    entry !== null &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).binding === 'EVENTS_RAW'
  )) as Record<string, unknown>[]
  if (matches.length !== 1 || typeof matches[0]?.bucket_name !== 'string' || !matches[0].bucket_name) {
    throw new Error('wrangler.jsonc must declare exactly one EVENTS_RAW bucket_name')
  }
  return {
    bucketName: matches[0].bucket_name,
    ...(routes.retention?.r2Days ? { r2Days: routes.retention.r2Days } : {}),
    ...(routes.retention?.d1Days ? { d1Days: routes.retention.d1Days } : {}),
  }
}

export function managedLifecycleRule(r2Days: number): LifecycleRule {
  return {
    id: MANAGED_RETENTION_RULE_ID,
    enabled: true,
    conditions: { prefix: MANAGED_RETENTION_PREFIX },
    deleteObjectsTransition: {
      condition: { type: 'Age', maxAge: r2Days * SECONDS_PER_DAY },
    },
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

export function computeLifecyclePlan(
  bucketName: string,
  r2Days: number | undefined,
  currentRules: LifecycleRule[],
): LifecyclePlan {
  const expected = r2Days === undefined ? null : managedLifecycleRule(r2Days)
  const currentManaged = currentRules.filter((rule) => rule.id === MANAGED_RETENTION_RULE_ID)
  const currentState = expected === null
    ? currentManaged.length === 0 ? 'missing' : 'unexpected'
    : currentManaged.length === 0
      ? 'missing'
      : currentManaged.length === 1 && canonicalize(currentManaged[0]) === canonicalize(expected)
        ? 'matches'
        : 'drifted'
  const desiredRules: LifecycleRule[] = []
  let inserted = false
  for (const rule of currentRules) {
    if (rule.id !== MANAGED_RETENTION_RULE_ID) {
      desiredRules.push(rule)
      continue
    }
    if (!inserted && expected) desiredRules.push(expected)
    inserted = true
  }
  if (!inserted && expected) desiredRules.push(expected)
  return {
    bucketName,
    ...(r2Days === undefined ? {} : { r2Days }),
    currentState,
    unrelatedRules: currentRules.length - currentManaged.length,
    changed: canonicalize(currentRules) !== canonicalize(desiredRules),
    desiredRules,
  }
}

export function formatLifecyclePlan(plan: LifecyclePlan): string {
  return [
    `R2 bucket: ${plan.bucketName}`,
    `Managed rule: ${MANAGED_RETENTION_RULE_ID}`,
    `Scope: ${MANAGED_RETENTION_PREFIX}`,
    `Desired expiration: ${plan.r2Days === undefined ? 'disabled' : `${plan.r2Days} days`}`,
    `Current managed state: ${plan.currentState}`,
    `Unrelated rules preserved: ${plan.unrelatedRules}`,
    `Change: ${plan.changed ? 'required' : 'none'}`,
  ].join('\n')
}

function cloudflareCredentials(environment: RetentionDependencies['environment']): {
  accountId: string
  apiToken: string
} {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID
  const apiToken = environment.CLOUDFLARE_API_TOKEN
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required')
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required')
  return { accountId, apiToken }
}

function lifecycleUrl(accountId: string, bucketName: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/lifecycle`
}

function isLifecycleRule(value: unknown): value is LifecycleRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const rule = value as Record<string, unknown>
  if (
    typeof rule.id !== 'string' ||
    typeof rule.enabled !== 'boolean' ||
    typeof rule.conditions !== 'object' ||
    rule.conditions === null ||
    Array.isArray(rule.conditions)
  ) return false
  const prefix = (rule.conditions as Record<string, unknown>).prefix
  return prefix === undefined || prefix === null || typeof prefix === 'string'
}

export async function getLifecycleRules(
  bucketName: string,
  dependencies: RetentionDependencies = DEFAULT_DEPENDENCIES,
): Promise<LifecycleRule[]> {
  const credentials = cloudflareCredentials(dependencies.environment)
  const response = await dependencies.fetch(lifecycleUrl(credentials.accountId, bucketName), {
    headers: { authorization: `Bearer ${credentials.apiToken}` },
  })
  if (!response.ok) throw new Error(`Cloudflare lifecycle GET failed with HTTP ${response.status}`)
  const body = await response.json() as {
    success?: boolean
    result?: { rules?: unknown[] }
  }
  if (body.success !== true || !body.result) {
    throw new Error('Cloudflare lifecycle GET returned an invalid response')
  }
  const rules = body.result.rules ?? []
  if (!Array.isArray(rules) || !rules.every(isLifecycleRule)) {
    throw new Error('Cloudflare lifecycle GET returned an invalid rule')
  }
  return rules
}

export async function putLifecycleRules(
  bucketName: string,
  rules: LifecycleRule[],
  dependencies: RetentionDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const credentials = cloudflareCredentials(dependencies.environment)
  const response = await dependencies.fetch(lifecycleUrl(credentials.accountId, bucketName), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ rules }),
  })
  if (!response.ok) throw new Error(`Cloudflare lifecycle PUT failed with HTTP ${response.status}`)
}

export async function runRetentionCommand(
  options: RetentionOptions,
  dependencies: RetentionDependencies = DEFAULT_DEPENDENCIES,
): Promise<'disabled' | 'planned' | 'applied' | 'verified' | 'cancelled' | 'unchanged'> {
  const [routesText, wranglerText] = await Promise.all([
    dependencies.readText('routes.jsonc'),
    dependencies.readText('wrangler.jsonc'),
  ])
  const settings = parseRetentionSettings(routesText, wranglerText)
  const currentRules = await getLifecycleRules(settings.bucketName, dependencies)
  const plan = computeLifecyclePlan(settings.bucketName, settings.r2Days, currentRules)
  dependencies.log(formatLifecyclePlan(plan))
  if (options.phase === 'plan') return 'planned'
  if (options.phase === 'verify') {
    if (plan.changed) throw new Error('managed R2 lifecycle rule does not match routes.jsonc')
    dependencies.log('Verified managed R2 lifecycle rule')
    return 'verified'
  }
  if (!plan.changed) {
    dependencies.log('Managed R2 lifecycle rule already matches')
    return 'unchanged'
  }
  if (!options.yes && !(await dependencies.confirm('Apply the managed R2 lifecycle state?'))) {
    dependencies.log('Cancelled')
    return 'cancelled'
  }

  await putLifecycleRules(settings.bucketName, plan.desiredRules, dependencies)
  const verifiedRules = await getLifecycleRules(settings.bucketName, dependencies)
  const verification = computeLifecyclePlan(settings.bucketName, settings.r2Days, verifiedRules)
  if (verification.changed) throw new Error('managed R2 lifecycle rule did not verify after apply')
  dependencies.log('Applied and verified managed R2 lifecycle state')
  return 'applied'
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(retentionUsage())
    return
  }
  await runRetentionCommand(parseRetentionArgs(argv))
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
