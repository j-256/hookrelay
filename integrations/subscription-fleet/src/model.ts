import { hashSubscriptionSlug } from '../../../src/lib/subscription'
import { envSegment } from '../../../scripts/setup'
import type { Sub } from '../../../scripts/sync'
import type { ManagedSubscriptionManifestEntry } from './manifest'

export const MANAGED_SUBSCRIPTION_AUTH_SCHEME = 'hookrelay-sha256'
export const MANAGED_SUBSCRIPTION_SOURCE = 'cloudevents'
export const MANAGED_SUBSCRIPTION_VERIFICATION_TYPE = 'urn:hookrelay:subscription-fleet:verification:v1'

export function managedSubscriptionHmacName(name: string): string {
  return `HMAC_${envSegment(name)}`
}

export async function buildManagedSubscription(
  name: string,
  entry: ManagedSubscriptionManifestEntry,
): Promise<Sub> {
  return {
    name,
    source: entry.source,
    slugHash: await hashSubscriptionSlug(entry.recovery.slug),
    enabled: true,
    sinks: [...entry.sinks],
    ...(entry.fallbackUrl ? { fallbackUrl: entry.fallbackUrl } : {}),
    auth: {
      scheme: MANAGED_SUBSCRIPTION_AUTH_SCHEME,
      secretEnv: entry.recovery.hmac.name,
    },
    ...(entry.filter ? { filter: entry.filter } : {}),
    ...(entry.sinkFilters ? { sinkFilters: entry.sinkFilters } : {}),
  }
}

export function managedSubscriptionUrl(baseUrl: string, entry: ManagedSubscriptionManifestEntry): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('routes.jsonc baseUrl must be an HTTPS origin')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('routes.jsonc baseUrl must be an HTTPS origin')
  }
  return `${parsed.origin}/hook/${entry.source}/${entry.recovery.slug}`
}
