import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import worker from '../../src/index'

describe('unknown slug', () => {
  it('returns 404 for slug-shape paths whose KV entry is missing', async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await worker.fetch(
      new Request('https://hooks.example.com/hook/statuspage/' + 'z'.repeat(22), {
        method: 'POST',
        body: '{}',
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 for slug-shape paths with a wrong-source slug', async () => {
    const slug = 'wrongsrc-aaaaaaaaaaaaaaa'
    await env.SUBS.put(
      `sub:${slug}`,
      JSON.stringify({ name: 'x', source: 'statuspage', enabled: true, sinks: [], auth: null }),
    )
    try {
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      const res = await worker.fetch(
        new Request(`https://hooks.example.com/hook/github/${slug}`, { method: 'POST', body: '{}' }),
        env,
        ctx,
      )
      expect(res.status).toBe(404)
    } finally {
      await env.SUBS.delete(`sub:${slug}`)
    }
  })
})
