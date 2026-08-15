import { z } from 'zod'
import { getDevVar, type SecretValue } from './setup'
import { sinkSchema, subSchema, type SinkRef, type Sub } from './sync'

const MANIFEST_VERSION = 1
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const secretSchema = z.object({
  name: z.string().regex(SECRET_NAME_RE),
  value: z.string().min(1),
}).strict()

const hookSchema = z.object({
  repo: z.string().min(1),
  id: z.number().int().positive(),
  deleted: z.boolean(),
}).strict()

const subscriptionArchiveSchema = z.object({
  subscription: subSchema,
  secrets: z.array(secretSchema),
  unavailableSecretNames: z.array(z.string().regex(SECRET_NAME_RE)),
  hook: hookSchema.optional(),
  localRemoved: z.boolean(),
  kvRemoved: z.boolean(),
  secretsRemoved: z.boolean(),
}).strict()

const sinkArchiveSchema = z.object({
  sink: sinkSchema,
  secrets: z.array(secretSchema),
  unavailableSecretNames: z.array(z.string().regex(SECRET_NAME_RE)),
  localRemoved: z.boolean(),
  kvRemoved: z.boolean(),
  secretsRemoved: z.boolean(),
}).strict()

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  subscriptions: z.record(z.string().min(1), subscriptionArchiveSchema),
  sinks: z.record(z.string().min(1), sinkArchiveSchema),
}).strict()

export type RetirementManifest = z.infer<typeof manifestSchema>
export type SubscriptionRetirementArchive = z.infer<typeof subscriptionArchiveSchema>
export type SinkRetirementArchive = z.infer<typeof sinkArchiveSchema>

export interface CapturedSecrets {
  secrets: SecretValue[]
  unavailableSecretNames: string[]
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

function assertUniqueSecrets(
  owner: string,
  secrets: readonly SecretValue[],
  unavailableSecretNames: readonly string[],
): void {
  const availableNames = secrets.map((secret) => secret.name)
  if (new Set(availableNames).size !== availableNames.length) {
    throw new Error(`${owner}: archived secret name appears more than once`)
  }
  if (new Set(unavailableSecretNames).size !== unavailableSecretNames.length) {
    throw new Error(`${owner}: unavailable secret name appears more than once`)
  }
  for (const name of unavailableSecretNames) {
    if (availableNames.includes(name)) throw new Error(`${owner}: secret is both archived and unavailable`)
  }
}

export function emptyRetirementManifest(): RetirementManifest {
  return { version: MANIFEST_VERSION, subscriptions: {}, sinks: {} }
}

export function validateRetirementManifest(manifest: RetirementManifest): void {
  for (const [name, archive] of Object.entries(manifest.subscriptions)) {
    if (archive.subscription.name !== name) throw new Error(`subscription archive key does not match ${name}`)
    assertUniqueSecrets(`subscription ${name}`, archive.secrets, archive.unavailableSecretNames)
  }
  for (const [name, archive] of Object.entries(manifest.sinks)) {
    if (archive.sink.name !== name) throw new Error(`sink archive key does not match ${name}`)
    assertUniqueSecrets(`sink ${name}`, archive.secrets, archive.unavailableSecretNames)
  }
}

export function parseRetirementManifest(text: string): RetirementManifest {
  if (text.trim() === '') return emptyRetirementManifest()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('failed to parse retirement manifest as JSON')
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    throw new Error(`invalid retirement manifest\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
  }
  validateRetirementManifest(result.data)
  return result.data
}

function sortedSecrets(secrets: readonly SecretValue[]): SecretValue[] {
  return [...secrets]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((secret) => ({ name: secret.name, value: secret.value }))
}

export function serializeRetirementManifest(manifest: RetirementManifest): string {
  validateRetirementManifest(manifest)
  const subscriptions: RetirementManifest['subscriptions'] = {}
  const sinks: RetirementManifest['sinks'] = {}
  for (const name of Object.keys(manifest.subscriptions).sort()) {
    const archive = manifest.subscriptions[name]!
    subscriptions[name] = {
      subscription: archive.subscription,
      secrets: sortedSecrets(archive.secrets),
      unavailableSecretNames: [...archive.unavailableSecretNames].sort(),
      ...(archive.hook ? { hook: { ...archive.hook } } : {}),
      localRemoved: archive.localRemoved,
      kvRemoved: archive.kvRemoved,
      secretsRemoved: archive.secretsRemoved,
    }
  }
  for (const name of Object.keys(manifest.sinks).sort()) {
    const archive = manifest.sinks[name]!
    sinks[name] = {
      sink: archive.sink,
      secrets: sortedSecrets(archive.secrets),
      unavailableSecretNames: [...archive.unavailableSecretNames].sort(),
      localRemoved: archive.localRemoved,
      kvRemoved: archive.kvRemoved,
      secretsRemoved: archive.secretsRemoved,
    }
  }
  return `${JSON.stringify({ version: MANIFEST_VERSION, subscriptions, sinks }, null, 2)}\n`
}

export function captureSecretValues(names: readonly string[], devVarsText: string): CapturedSecrets {
  const secrets: SecretValue[] = []
  const unavailableSecretNames: string[] = []
  for (const name of [...new Set(names)].sort()) {
    const value = getDevVar(devVarsText, name)
    if (value === null) unavailableSecretNames.push(name)
    else secrets.push({ name, value })
  }
  return { secrets, unavailableSecretNames }
}

function sameArchiveValue(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right)
}

export function archiveSubscription(
  manifest: RetirementManifest,
  subscription: Sub,
  captured: CapturedSecrets,
): RetirementManifest {
  const existing = manifest.subscriptions[subscription.name]
  if (existing) {
    if (!sameArchiveValue(existing.subscription, subscription)) {
      throw new Error(`subscription ${subscription.name} disagrees with its retirement archive`)
    }
    return manifest
  }
  return {
    ...manifest,
    subscriptions: {
      ...manifest.subscriptions,
      [subscription.name]: {
        subscription,
        ...captured,
        localRemoved: false,
        kvRemoved: false,
        secretsRemoved: false,
      },
    },
  }
}

export function archiveSink(
  manifest: RetirementManifest,
  sink: SinkRef,
  captured: CapturedSecrets,
): RetirementManifest {
  const existing = manifest.sinks[sink.name]
  if (existing) {
    if (!sameArchiveValue(existing.sink, sink)) {
      throw new Error(`sink ${sink.name} disagrees with its retirement archive`)
    }
    return manifest
  }
  return {
    ...manifest,
    sinks: {
      ...manifest.sinks,
      [sink.name]: {
        sink,
        ...captured,
        localRemoved: false,
        kvRemoved: false,
        secretsRemoved: false,
      },
    },
  }
}

export function subscriptionSecretNames(subscription: Sub): string[] {
  if (!subscription.auth) return []
  return [subscription.auth.secretEnv, ...(subscription.auth.alternateSecretEnvs ?? [])]
}

export function sinkSecretNames(sink: SinkRef): string[] {
  return Object.entries(sink)
    .filter(([field, value]) => field.endsWith('Env') && typeof value === 'string')
    .map(([, value]) => value as string)
}

export function routeReferencesSecret(routes: unknown, secretName: string): boolean {
  if (routes === secretName) return true
  if (Array.isArray(routes)) return routes.some((value) => routeReferencesSecret(value, secretName))
  if (routes === null || typeof routes !== 'object') return false
  return Object.values(routes as Record<string, unknown>).some((value) => routeReferencesSecret(value, secretName))
}
