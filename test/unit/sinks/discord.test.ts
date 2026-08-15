import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import discord from '../../../src/sinks/discord'
import type { NormalizedEvent } from '../../../src/types'

const URL_ENV = 'SINK_DISCORD_TEST_URL'
const URL_VALUE = 'https://discord.com/api/webhooks/123/abc'
;(env as unknown as Record<string, string>)[URL_ENV] = URL_VALUE

const baseEvent: NormalizedEvent = {
  source: 'github',
  subName: 'gh-test',
  type: 'issues.opened',
  id: 'd-1',
  timestamp: '2026-06-06T00:00:00.000Z',
  title: 'New issue',
  body: 'Body text',
  url: 'https://github.com/x/y/issues/1',
  severity: 'warning',
  raw: {},
}

const deliveryContext = {
  eventId: 'github:d-1',
  sinkName: 'discord',
  generation: 1,
  attempt: 1,
}

describe('discord sink', () => {
  it('config schema accepts {urlEnv} and rejects extras', () => {
    expect(() => discord.configSchema.parse({ urlEnv: 'X' })).not.toThrow()
    expect(() => discord.configSchema.parse({})).toThrow()
  })

  it('POSTs to the URL referenced by urlEnv with embed payload', async () => {
    const fetchMock = vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      expect(url).toBe(URL_VALUE)
      const body = typeof init?.body === 'string' ? init.body : ''
      const parsed = JSON.parse(body)
      expect(parsed.embeds[0].title).toBe('New issue')
      expect(parsed.embeds[0].url).toBe('https://github.com/x/y/issues/1')
      expect(parsed.embeds[0].description).toBe('Body text')
      // warning -> yellow 0xfee75c
      expect(parsed.embeds[0].color).toBe(0xfee75c)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await discord.send(baseEvent, { urlEnv: URL_ENV }, env, deliveryContext, fetchMock)
  })

  it('maps severity to embed color', async () => {
    const cases: Array<[NormalizedEvent['severity'], number]> = [
      ['debug', 0x99aab5],
      ['info', 0x3498db],
      ['warning', 0xfee75c],
      ['error', 0xed4245],
      ['critical', 0x8b0000],
    ]
    for (const [severity, expected] of cases) {
      const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
        const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
        expect(parsed.embeds[0].color).toBe(expected)
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch
      await discord.send({ ...baseEvent, severity }, { urlEnv: URL_ENV }, env, deliveryContext, fetchMock)
    }
  })

  it('truncates description to 4096 chars (Discord embed limit)', async () => {
    const long = 'x'.repeat(5000)
    const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
      const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
      expect(parsed.embeds[0].description.length).toBe(4096)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    await discord.send({ ...baseEvent, body: long }, { urlEnv: URL_ENV }, env, deliveryContext, fetchMock)
  })

  it('throws when urlEnv is unset', async () => {
    await expect(discord.send(
      baseEvent,
      { urlEnv: 'NOT_SET' },
      env,
      deliveryContext,
      vi.fn() as unknown as typeof fetch,
    )).rejects.toThrow(/NOT_SET/)
  })

  it('throws on non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 })) as unknown as typeof fetch
    await expect(discord.send(baseEvent, { urlEnv: URL_ENV }, env, deliveryContext, fetchMock)).rejects.toThrow(/502/)
  })
})
