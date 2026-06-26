import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../src/index'

const SUB_SLUG = 'disabled-aaaaaaaaaaaaaaaa'
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.SUBS.put(
    `sub:${SUB_SLUG}`,
    JSON.stringify({ name: 'disabled', source: 'statuspage', enabled: false, sinks: [], auth: null }),
  )
})

afterEach(async () => {
  await env.SUBS.delete(`sub:${SUB_SLUG}`)
})

describe('disabled subscription', () => {
  it('returns 204 without persisting or fanning out', async () => {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await worker.fetch(
      new Request(`https://hooks.example.com/hook/statuspage/${SUB_SLUG}`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(204)
  })
})
