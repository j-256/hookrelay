import { z } from 'zod'
import { normalizeFallbackUrl } from '../../../src/lib/public-url'
import { SUBSCRIPTION_SLUG_RE } from '../../../src/lib/subscription'
import { subSchema } from '../../../scripts/sync'
import {
  MANAGED_SUBSCRIPTION_AUTH_SCHEME,
  MANAGED_SUBSCRIPTION_SOURCE,
  managedSubscriptionHmacName,
} from './model'

export const MANAGED_SUBSCRIPTION_MANIFEST_VERSION = 1

const SUBSCRIPTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/
const HMAC_VALUE_RE = /^[a-f0-9]{64}$/

const senderSchema = z.object({
  kind: z.literal('cloudflare-worker'),
  configPath: z.string().startsWith('/'),
  urlSecretName: z.string().regex(SECRET_NAME_RE),
  hmacSecretName: z.string().regex(SECRET_NAME_RE),
}).strict()

const recoverySchema = z.object({
  hmac: z.object({
    name: z.string().regex(SECRET_NAME_RE),
    value: z.string().regex(HMAC_VALUE_RE),
  }).strict(),
  slug: z.string().regex(SUBSCRIPTION_SLUG_RE),
}).strict()

const routeFieldsSchema = subSchema.pick({
  sinks: true,
  fallbackUrl: true,
  filter: true,
  sinkFilters: true,
})

export const managedSubscriptionManifestEntrySchema = routeFieldsSchema.extend({
  source: z.literal(MANAGED_SUBSCRIPTION_SOURCE),
  sender: senderSchema.optional(),
  recovery: recoverySchema,
  state: z.literal('active'),
}).strict()

const manifestSchema = z.object({
  version: z.literal(MANAGED_SUBSCRIPTION_MANIFEST_VERSION),
  subscriptions: z.record(z.string().regex(SUBSCRIPTION_NAME_RE), managedSubscriptionManifestEntrySchema),
}).strict()

export type ManagedSubscriptionManifestEntry = z.infer<typeof managedSubscriptionManifestEntrySchema>
export type ManagedSubscriptionManifest = z.infer<typeof manifestSchema>

export function emptyManagedSubscriptionManifest(): ManagedSubscriptionManifest {
  return { version: MANAGED_SUBSCRIPTION_MANIFEST_VERSION, subscriptions: {} }
}

function validateEntry(name: string, entry: ManagedSubscriptionManifestEntry): void {
  const expectedHmacName = managedSubscriptionHmacName(name)
  if (entry.recovery.hmac.name !== expectedHmacName) {
    throw new Error(`managed subscription ${name} must use HMAC name ${expectedHmacName}`)
  }
  if (new Set(entry.sinks).size !== entry.sinks.length) {
    throw new Error(`managed subscription ${name} has duplicate sinks`)
  }
  if (entry.fallbackUrl) normalizeFallbackUrl(entry.fallbackUrl)
  const filters = [
    ['subscription', entry.filter] as const,
    ...Object.entries(entry.sinkFilters ?? {}).map(([sinkName, filter]) => [
      `sink ${sinkName}`,
      filter,
    ] as const),
  ]
  for (const [label, filter] of filters) {
    for (const [mode, patterns] of Object.entries(filter?.eventTypes ?? {})) {
      if (patterns && new Set(patterns).size !== patterns.length) {
        throw new Error(`managed subscription ${name} ${label} has duplicate event type ${mode} patterns`)
      }
    }
    for (const [mode, severities] of Object.entries(filter?.severities ?? {})) {
      if (severities && new Set(severities).size !== severities.length) {
        throw new Error(`managed subscription ${name} ${label} has duplicate severity ${mode} values`)
      }
    }
  }
  for (const sinkName of Object.keys(entry.sinkFilters ?? {})) {
    if (!entry.sinks.includes(sinkName)) {
      throw new Error(`managed subscription ${name} has a filter for unselected sink ${sinkName}`)
    }
  }
  if (entry.sender && entry.sender.urlSecretName === entry.sender.hmacSecretName) {
    throw new Error(`managed subscription ${name} sender secret names must differ`)
  }
  subSchema.parse({
    name,
    source: entry.source,
    slugHash: '0'.repeat(64),
    enabled: true,
    sinks: entry.sinks,
    ...(entry.fallbackUrl ? { fallbackUrl: entry.fallbackUrl } : {}),
    auth: {
      scheme: MANAGED_SUBSCRIPTION_AUTH_SCHEME,
      secretEnv: entry.recovery.hmac.name,
    },
    ...(entry.filter ? { filter: entry.filter } : {}),
    ...(entry.sinkFilters ? { sinkFilters: entry.sinkFilters } : {}),
  })
}

export function validateManagedSubscriptionManifest(manifest: ManagedSubscriptionManifest): void {
  const slugOwners = new Map<string, string>()
  const hmacNameOwners = new Map<string, string>()
  const hmacValueOwners = new Map<string, string>()
  const senderSecretOwners = new Map<string, string>()
  for (const [name, entry] of Object.entries(manifest.subscriptions)) {
    validateEntry(name, entry)
    const slugOwner = slugOwners.get(entry.recovery.slug)
    if (slugOwner) throw new Error(`managed subscriptions ${slugOwner} and ${name} share a slug`)
    slugOwners.set(entry.recovery.slug, name)
    const hmacNameOwner = hmacNameOwners.get(entry.recovery.hmac.name)
    if (hmacNameOwner) {
      throw new Error(`managed subscriptions ${hmacNameOwner} and ${name} share an HMAC name`)
    }
    hmacNameOwners.set(entry.recovery.hmac.name, name)
    const hmacValueOwner = hmacValueOwners.get(entry.recovery.hmac.value)
    if (hmacValueOwner) {
      throw new Error(`managed subscriptions ${hmacValueOwner} and ${name} share an HMAC value`)
    }
    hmacValueOwners.set(entry.recovery.hmac.value, name)
    if (entry.sender) {
      for (const secretName of [entry.sender.urlSecretName, entry.sender.hmacSecretName]) {
        const key = `${entry.sender.configPath}\0${secretName}`
        const owner = senderSecretOwners.get(key)
        if (owner) {
          throw new Error(`managed subscriptions ${owner} and ${name} share sender secret ${secretName}`)
        }
        senderSecretOwners.set(key, name)
      }
    }
  }
}

export function parseManagedSubscriptionManifest(text: string): ManagedSubscriptionManifest {
  if (text.trim() === '') return emptyManagedSubscriptionManifest()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('failed to parse managed subscription manifest as JSON')
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    throw new Error(`invalid managed subscription manifest\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
  }
  validateManagedSubscriptionManifest(result.data)
  return result.data
}

export function serializeManagedSubscriptionManifest(manifest: ManagedSubscriptionManifest): string {
  validateManagedSubscriptionManifest(manifest)
  const subscriptions = Object.fromEntries(
    Object.keys(manifest.subscriptions).sort().map((name) => [name, manifest.subscriptions[name]]),
  )
  return `${JSON.stringify({ version: MANAGED_SUBSCRIPTION_MANIFEST_VERSION, subscriptions }, null, 2)}\n`
}
