import { describe, expect, it } from 'vitest'
import {
  hashSubscriptionSlug,
  SUBSCRIPTION_KEY_PREFIX,
  subscriptionKvKey,
  subscriptionKvKeyForSlug,
} from '../../src/lib/subscription'

describe('subscription credentials', () => {
  it('hashes slugs with SHA-256', async () => {
    await expect(hashSubscriptionSlug('a'.repeat(22))).resolves.toBe(
      'ec7c494df6d2a7ea36668d656e6b8979e33641bfea378c15038af3964db057a3',
    )
  })

  it('builds versioned KV keys from hashes and raw slugs', async () => {
    const slug = 'a'.repeat(22)
    const hash = await hashSubscriptionSlug(slug)
    expect(subscriptionKvKey(hash)).toBe(`${SUBSCRIPTION_KEY_PREFIX}${hash}`)
    await expect(subscriptionKvKeyForSlug(slug)).resolves.toBe(`${SUBSCRIPTION_KEY_PREFIX}${hash}`)
  })

  it('rejects malformed hash keys', () => {
    expect(() => subscriptionKvKey('not-a-hash')).toThrow(/invalid subscription slug hash/)
    expect(() => subscriptionKvKey('A'.repeat(64))).toThrow(/invalid subscription slug hash/)
  })

  it('rejects malformed raw slugs', async () => {
    await expect(hashSubscriptionSlug('too-short')).rejects.toThrow(/invalid subscription slug/)
  })
})
