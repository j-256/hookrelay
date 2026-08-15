import { describe, expect, it } from 'vitest'
import {
  archiveSink,
  archiveSubscription,
  captureSecretValues,
  emptyRetirementManifest,
  parseRetirementManifest,
  serializeRetirementManifest,
} from '../../scripts/retirement-manifest'
import type { SinkRef, Sub } from '../../scripts/sync'

const SUBSCRIPTION: Sub = {
  name: 'github:example/repo',
  source: 'github',
  slugHash: 'a'.repeat(64),
  enabled: false,
  sinks: ['delivery'],
  auth: {
    scheme: 'github-sha256',
    secretEnv: 'HMAC_REPO',
    alternateSecretEnvs: ['HMAC_REPO_OLD'],
  },
  setup: { github: { repo: 'example/repo', eventProfiles: ['push'] } },
}

const SINK: SinkRef = {
  name: 'delivery',
  type: 'webhook',
  urlEnv: 'SINK_DELIVERY_URL',
  signingSecretEnv: 'SINK_DELIVERY_SIGNING_SECRET',
}

describe('retirement manifest', () => {
  it('captures available values, records unavailable names, and round-trips strict JSON', () => {
    const captured = captureSecretValues(
      ['HMAC_REPO', 'HMAC_REPO_OLD'],
      'HMAC_REPO=private-value\n',
    )
    let manifest = archiveSubscription(emptyRetirementManifest(), SUBSCRIPTION, captured)
    manifest = archiveSink(manifest, SINK, captureSecretValues(
      ['SINK_DELIVERY_URL', 'SINK_DELIVERY_SIGNING_SECRET'],
      'SINK_DELIVERY_URL=https://receiver.example/hook\nSINK_DELIVERY_SIGNING_SECRET=signing-value\n',
    ))
    const text = serializeRetirementManifest(manifest)
    const parsed = parseRetirementManifest(text)
    expect(parsed.subscriptions[SUBSCRIPTION.name]).toMatchObject({
      subscription: SUBSCRIPTION,
      secrets: [{ name: 'HMAC_REPO', value: 'private-value' }],
      unavailableSecretNames: ['HMAC_REPO_OLD'],
      localRemoved: false,
      kvRemoved: false,
      secretsRemoved: false,
    })
    expect(parsed.sinks[SINK.name]?.secrets).toHaveLength(2)
    expect(() => parseRetirementManifest(text.replace('"version": 1', '"version": 1, "extra": true'))).toThrow(/Unrecognized key/)
  })

  it('refuses archive drift without exposing either secret value', () => {
    const original = archiveSubscription(
      emptyRetirementManifest(),
      SUBSCRIPTION,
      { secrets: [{ name: 'HMAC_REPO', value: 'first-private-value' }], unavailableSecretNames: [] },
    )
    let error: Error | undefined
    try {
      archiveSubscription(
        original,
        { ...SUBSCRIPTION, source: 'statuspage' },
        { secrets: [{ name: 'HMAC_REPO', value: 'second-private-value' }], unavailableSecretNames: [] },
      )
    } catch (caught) {
      error = caught as Error
    }
    expect(error?.message).toMatch(/disagrees/)
    expect(error?.message).not.toContain('first-private-value')
    expect(error?.message).not.toContain('second-private-value')
  })
})
