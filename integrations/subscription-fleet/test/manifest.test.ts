import { describe, expect, it } from 'vitest'
import {
  parseManagedSubscriptionManifest,
  serializeManagedSubscriptionManifest,
  type ManagedSubscriptionManifest,
} from '../src/manifest'

const ENTRY = Object.freeze({
  source: 'cloudevents' as const,
  sinks: ['discord:service-status'],
  filter: {
    eventTypes: {
      include: [
        'urn:cloudflare-fleet:endpoint:problem:v1',
        'urn:cloudflare-fleet:endpoint:recovered:v1',
      ],
    },
  },
  sender: {
    kind: 'cloudflare-worker' as const,
    configPath: '/workspace/cloudflare-fleet/wrangler.jsonc',
    urlSecretName: 'FLEET_MONITOR_HOOKRELAY_URL',
    hmacSecretName: 'FLEET_MONITOR_HOOKRELAY_HMAC',
  },
  recovery: {
    hmac: { name: 'HMAC_CLOUDFLARE_FLEET', value: 'a'.repeat(64) },
    slug: 'managed_slug_123456789',
  },
  state: 'active' as const,
})

function manifest(): ManagedSubscriptionManifest {
  return {
    version: 1,
    subscriptions: { 'cloudflare-fleet': structuredClone(ENTRY) },
  }
}

describe('managed subscription manifest', () => {
  it('round-trips a signed CloudEvents sender without changing recovery', () => {
    const value = manifest()
    expect(parseManagedSubscriptionManifest(serializeManagedSubscriptionManifest(value))).toEqual(value)
  })

  it('requires the canonical subscription HMAC name', () => {
    const value = manifest()
    value.subscriptions['cloudflare-fleet']!.recovery.hmac.name = 'HMAC_WRONG'
    expect(() => serializeManagedSubscriptionManifest(value)).toThrow(/must use HMAC name HMAC_CLOUDFLARE_FLEET/)
  })

  it('rejects shared recovery values and duplicate sink mappings', () => {
    const value = manifest()
    value.subscriptions['second-service'] = {
      ...structuredClone(ENTRY),
      recovery: {
        hmac: { name: 'HMAC_SECOND_SERVICE', value: 'a'.repeat(64) },
        slug: 'different_slug_123456',
      },
    }
    expect(() => serializeManagedSubscriptionManifest(value)).toThrow(/share an HMAC value/)

    const duplicateSinks = manifest()
    duplicateSinks.subscriptions['cloudflare-fleet']!.sinks.push('discord:service-status')
    expect(() => serializeManagedSubscriptionManifest(duplicateSinks)).toThrow(/duplicate sinks/)
  })

  it('rejects unknown fields and reused sender secret names', () => {
    const value = manifest()
    value.subscriptions['cloudflare-fleet']!.sender!.hmacSecretName = 'FLEET_MONITOR_HOOKRELAY_URL'
    expect(() => serializeManagedSubscriptionManifest(value)).toThrow(/sender secret names must differ/)
    expect(() => parseManagedSubscriptionManifest(JSON.stringify({
      ...manifest(),
      unknown: true,
    }))).toThrow(/Unrecognized key/)
  })

  it('rejects sender secret collisions within one Worker', () => {
    const value = manifest()
    value.subscriptions['second-service'] = {
      ...structuredClone(ENTRY),
      sender: {
        ...structuredClone(ENTRY.sender),
        hmacSecretName: 'SECOND_SERVICE_HMAC',
      },
      recovery: {
        hmac: { name: 'HMAC_SECOND_SERVICE', value: 'b'.repeat(64) },
        slug: 'different_slug_123456',
      },
    }
    expect(() => serializeManagedSubscriptionManifest(value))
      .toThrow(/share sender secret FLEET_MONITOR_HOOKRELAY_URL/)
  })

  it('rejects invalid routing fields before reconciliation', () => {
    const unselectedSink = manifest()
    unselectedSink.subscriptions['cloudflare-fleet']!.sinkFilters = {
      'discord:other': { severities: { include: ['critical'] } },
    }
    expect(() => serializeManagedSubscriptionManifest(unselectedSink))
      .toThrow(/filter for unselected sink discord:other/)

    const duplicateEvents = manifest()
    duplicateEvents.subscriptions['cloudflare-fleet']!.filter!.eventTypes!.include!.push(
      'urn:cloudflare-fleet:endpoint:problem:v1',
    )
    expect(() => serializeManagedSubscriptionManifest(duplicateEvents))
      .toThrow(/duplicate event type include patterns/)

    const unsafeFallback = manifest()
    unsafeFallback.subscriptions['cloudflare-fleet']!.fallbackUrl = 'https://status.example.com/?token=value'
    expect(() => serializeManagedSubscriptionManifest(unsafeFallback)).toThrow(/must not contain credentials, a query, or a fragment/)
  })
})
