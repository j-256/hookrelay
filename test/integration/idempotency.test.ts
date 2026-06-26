import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import statuspageFixture from '../fixtures/statuspage/incident-investigating.json'

const SUB_SLUG = 'idemp-aaaaaaaaaaaaaaaaaa'
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})

beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM events')
  await env.SUBS.put(
    `sub:${SUB_SLUG}`,
    JSON.stringify({ name: 'idemp', source: 'statuspage', enabled: true, sinks: ['t-sink'], auth: null }),
  )
  await env.SINKS.put('sink:t-sink', JSON.stringify({ type: 'ntfy', topic: 'idemp' }))
})

afterEach(async () => {
  await env.SUBS.delete(`sub:${SUB_SLUG}`)
  await env.SINKS.delete('sink:t-sink')
})

const makeCtx = () => {
  const promises: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => promises.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
  return { ctx, promises }
}

describe('idempotency', () => {
  it('second POST of the same body returns duplicate:true and does not re-fanout', async () => {
    const calls: string[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      calls.push(url)
      return new Response('ok', { status: 200 })
    })
    const post = async () => {
      const { ctx, promises } = makeCtx()
      const res = await worker.fetch(
        new Request(`https://hooks.example.com/hook/statuspage/${SUB_SLUG}`, {
          method: 'POST',
          body: JSON.stringify(statuspageFixture),
          headers: { 'content-type': 'application/json' },
        }),
        env,
        ctx,
      )
      await Promise.all(promises)
      return res
    }

    const first = await post()
    expect(first.status).toBe(200)
    expect(await first.json<{ duplicate?: boolean }>()).not.toHaveProperty('duplicate')

    const second = await post()
    expect(second.status).toBe(200)
    expect((await second.json<{ duplicate?: boolean }>()).duplicate).toBe(true)

    // ntfy.sh fired only once -- the second post short-circuited before fanout
    const ntfyCalls = calls.filter((u) => u.startsWith('https://ntfy.sh/'))
    expect(ntfyCalls).toHaveLength(1)
    fetchSpy.mockRestore()
  })
})
