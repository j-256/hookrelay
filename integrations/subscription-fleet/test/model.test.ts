import { describe, expect, it } from 'vitest'
import { buildManagedSubscription, managedSubscriptionUrl } from '../src/model'
import type { ManagedSubscriptionManifestEntry } from '../src/manifest'

const ENTRY: ManagedSubscriptionManifestEntry = {
  source: 'cloudevents',
  sinks: ['discord:service-status'],
  filter: { eventTypes: { include: ['problem', 'recovered'] } },
  recovery: {
    hmac: { name: 'HMAC_CLOUDFLARE_FLEET', value: 'a'.repeat(64) },
    slug: 'managed_slug_123456789',
  },
  state: 'active',
}

describe('managed subscription model', () => {
  it('builds a hash-only Hookrelay route', async () => {
    const route = await buildManagedSubscription('cloudflare-fleet', ENTRY)
    expect(route).toMatchObject({
      name: 'cloudflare-fleet',
      source: 'cloudevents',
      enabled: true,
      sinks: ['discord:service-status'],
      auth: {
        scheme: 'hookrelay-sha256',
        secretEnv: 'HMAC_CLOUDFLARE_FLEET',
      },
    })
    expect(route.slugHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(route)).not.toContain(ENTRY.recovery.slug)
    expect(JSON.stringify(route)).not.toContain(ENTRY.recovery.hmac.value)
  })

  it('derives the private URL without accepting a path-bearing base URL', () => {
    expect(managedSubscriptionUrl('https://hooks.example.com', ENTRY)).toBe(
      `https://hooks.example.com/hook/cloudevents/${ENTRY.recovery.slug}`,
    )
    expect(() => managedSubscriptionUrl('https://hooks.example.com/path', ENTRY)).toThrow(/HTTPS origin/)
  })
})
