import { env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchSink } from '../../src/fanout'
import { HttpError } from '../../src/lib/http'
import { registerSink } from '../../src/sinks'
import type { Sink } from '../../src/sinks'
import type { NormalizedEvent } from '../../src/types'
import { z } from 'zod'

const event: NormalizedEvent = {
  source: 'fixture',
  subName: 'fixture-sub',
  type: 'fixture.event',
  id: 'evt-1',
  timestamp: '2026-06-06T00:00:00.000Z',
  title: 't',
  body: 'b',
  raw: {},
}

const okSpy = vi.fn(async () => {})
const failSpy = vi.fn(async () => {
  throw new Error('boom')
})
const rateLimitSpy = vi.fn(async () => {
  throw new HttpError('rate limited', 429, 120)
})

const okSink: Sink<{ note: string }> = {
  type: 'dispatch-ok',
  configSchema: z.object({ note: z.string() }).strict(),
  send: okSpy,
}
const failSink: Sink<{}> = {
  type: 'dispatch-fail',
  configSchema: z.object({}).strict(),
  send: failSpy,
}
const rateLimitSink: Sink<{}> = {
  type: 'dispatch-rate-limit',
  configSchema: z.object({}).strict(),
  send: rateLimitSpy,
}

beforeAll(() => {
  for (const sink of [okSink, failSink, rateLimitSink]) {
    try { registerSink(sink) } catch {}
  }
})

beforeEach(async () => {
  okSpy.mockClear()
  failSpy.mockClear()
  rateLimitSpy.mockClear()
  await env.SINKS.put('sink:ok-a', JSON.stringify({ type: 'dispatch-ok', note: 'hi' }))
  await env.SINKS.put('sink:fail-a', JSON.stringify({ type: 'dispatch-fail' }))
  await env.SINKS.put('sink:rate-limit-a', JSON.stringify({ type: 'dispatch-rate-limit' }))
})

afterEach(async () => {
  await env.SINKS.delete('sink:ok-a')
  await env.SINKS.delete('sink:fail-a')
  await env.SINKS.delete('sink:rate-limit-a')
  await env.SINKS.delete('sink:bogus')
})

describe('sink dispatch', () => {
  it('validates configuration and sends one event', async () => {
    await expect(dispatchSink(env, event, 'ok-a')).resolves.toEqual({ ok: true })
    expect(okSpy).toHaveBeenCalledOnce()
  })

  it('returns a sink error without throwing', async () => {
    const result = await dispatchSink(env, event, 'fail-a')
    expect(result.ok).toBe(false)
    expect(result.errMsg).toContain('boom')
  })

  it('returns a missing-sink error', async () => {
    const result = await dispatchSink(env, event, 'no-such-sink')
    expect(result.ok).toBe(false)
    expect(result.errMsg).toMatch(/no-such-sink/)
  })

  it('returns an unknown-sink-type error', async () => {
    await env.SINKS.put('sink:bogus', JSON.stringify({ type: 'unregistered' }))
    const result = await dispatchSink(env, event, 'bogus')
    expect(result.ok).toBe(false)
    expect(result.errMsg).toMatch(/unregistered/)
  })

  it('preserves Retry-After metadata from HTTP failures', async () => {
    const result = await dispatchSink(env, event, 'rate-limit-a')
    expect(result).toMatchObject({ ok: false, retryAfterSeconds: 120 })
  })
})
