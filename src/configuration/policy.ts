import { z } from 'zod'
import { EVENT_TYPE_FILTER_PATTERN_RE } from '../lib/event-filter'
import { SEVERITIES } from '../types'
import { ConfigurationError, type ConfigurationEntry } from './authority'

export const POLICY_LIMITS = Object.freeze({ DESTINATIONS: 100, PATTERNS: 100, PATTERN_LENGTH: 160 })
export const policyName = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/)
const pattern = z.string().max(POLICY_LIMITS.PATTERN_LENGTH).regex(EVENT_TYPE_FILTER_PATTERN_RE)
const unique = <Value>(values: Value[]) => new Set(values).size === values.length
const patterns = z.array(pattern).min(1).max(POLICY_LIMITS.PATTERNS).refine(unique)
const severities = z.array(z.enum(SEVERITIES)).min(1).max(SEVERITIES.length).refine(unique)
const typeFilter = z.object({ include: patterns.optional(), exclude: patterns.optional() }).strict()
  .refine(value => value.include !== undefined || value.exclude !== undefined)
const severityFilter = z.object({ include: severities.optional(), exclude: severities.optional() }).strict()
  .refine(value => value.include !== undefined || value.exclude !== undefined)
export const policyEventFilter = z.object({ eventTypes: typeFilter.optional(), severities: severityFilter.optional() }).strict()
  .refine(value => value.eventTypes !== undefined || value.severities !== undefined)
export const subscriptionPolicySchema = z.object({
  enabled: z.boolean(),
  sinks: z.array(policyName).max(POLICY_LIMITS.DESTINATIONS).refine(unique),
  filter: policyEventFilter.nullable(),
  sinkFilters: z.record(policyName, policyEventFilter),
}).strict().refine(value => Object.keys(value.sinkFilters).every(name => value.sinks.includes(name)))
export type SubscriptionPolicy = z.infer<typeof subscriptionPolicySchema>
const subscriptionMetadata = z.object({ name: policyName, source: policyName })

export function readSubscriptionPolicy(entry: ConfigurationEntry) {
  try {
    if (entry.namespace !== 'SUBS' || !entry.key.startsWith('sub:sha256:')) throw new Error()
    const value = JSON.parse(entry.value) as Record<string, unknown>
    const metadata = subscriptionMetadata.parse(value)
    const policy = subscriptionPolicySchema.parse({
      enabled: value.enabled, sinks: value.sinks, filter: value.filter ?? null, sinkFilters: value.sinkFilters ?? {},
    })
    return { resourceId: entry.resourceId, ...metadata, policy }
  } catch {
    throw new ConfigurationError('unavailable', 'Subscription policy could not be read safely')
  }
}

export function applySubscriptionPolicy(entry: ConfigurationEntry, input: SubscriptionPolicy): ConfigurationEntry {
  const policy = subscriptionPolicySchema.parse(input)
  readSubscriptionPolicy(entry)
  const value = JSON.parse(entry.value) as Record<string, unknown>
  delete value.filter
  delete value.sinkFilters
  return {
    ...entry,
    value: JSON.stringify({
      ...value, enabled: policy.enabled, sinks: policy.sinks,
      ...(policy.filter === null ? {} : { filter: policy.filter }),
      ...(Object.keys(policy.sinkFilters).length ? { sinkFilters: policy.sinkFilters } : {}),
    }),
  }
}
