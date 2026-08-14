import { describe, expect, it } from 'vitest'
import { createSubscription } from '../../scripts/new-sub'
import { hashSubscriptionSlug } from '../../src/lib/subscription'

describe('new-sub', () => {
  it('keeps the raw slug out of the config stub', async () => {
    const slug = 'a7f3b2c8d9e1f4g6h8j0k2'
    const generated = await createSubscription('claude-status', 'statuspage', slug)

    expect(generated.stub).toEqual({
      name: 'claude-status',
      source: 'statuspage',
      slugHash: await hashSubscriptionSlug(slug),
      enabled: true,
      sinks: ['discord'],
    })
    expect(JSON.stringify(generated.stub)).not.toContain(slug)
    expect(generated.webhookUrl).toBe(`https://hooks.example.com/hook/statuspage/${slug}`)
  })

  it('directs email sources to the guided address setup', async () => {
    await expect(createSubscription('openai-status', 'email'))
      .rejects.toThrow(/sub:add with --email-base/)
  })
})
