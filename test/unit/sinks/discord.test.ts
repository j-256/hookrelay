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

async function renderedDescription(
  body: string,
  options: { url?: string; summary?: string } = { url: baseEvent.url },
): Promise<string> {
  let description = ''
  const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
    const parsed = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
    description = parsed.embeds[0].description
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  await discord.send({ ...baseEvent, body, ...options, url: options.url }, { urlEnv: URL_ENV }, env, deliveryContext, fetchMock)
  return description
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

  it('converts embedded HTML to Discord-friendly text', async () => {
    const description = await renderedDescription([
      '<details>',
      '<summary>Release notes</summary>',
      '<ul>',
      '<li>Fix buffer over-read</li>',
      '<li>Support <code>Z_SYNC_FLUSH</code></li>',
      '</ul>',
      '<p>See <a href="https://example.com/release">the release</a>.</p>',
      '<p><code>@dependabot ignore <dependency name></code></p>',
      '</details>',
    ].join('\n'))

    expect(description).toBe([
      'Release notes',
      '',
      '- Fix buffer over-read',
      '- Support Z_SYNC_FLUSH',
      '',
      'See the release.',
      '',
      '@dependabot ignore <dependency name>',
    ].join('\n'))
  })

  it('renders structured JSON as indented code with its closing brace intact', async () => {
    const value = { state: 'problem', targetUrl: 'https://example.com/' }
    const description = await renderedDescription(JSON.stringify(value))
    expect(description).toBe('```json\n{\n  "state": "problem",\n  "targetUrl": "https://example.com/"\n}\n```')
    expect(JSON.parse(description.slice('```json\n'.length, -'\n```'.length))).toEqual(value)
    expect(description).not.toContain('%7D')
  })

  it('prefers a supplied summary over the original structured body', async () => {
    const body = '{"state":"problem","targetUrl":"https://example.com/"}'
    const summary = 'The expected content was missing.\n\nTarget: https://example.com/'
    expect(await renderedDescription(body, { summary })).toBe(summary)
  })

  it('preserves numeric tokens and duplicate keys without a serialization round trip', async () => {
    const body = '{"large":9007199254740993,"huge":1e400,"negativeZero":-0,"key":1,"key":2}'
    const description = await renderedDescription(body)
    expect(description).toBe([
      '```json', '{', '  "large": 9007199254740993,', '  "huge": 1e400,',
      '  "negativeZero": -0,', '  "key": 1,', '  "key": 2', '}', '```',
    ].join('\n'))
  })

  it('bounds deeply nested JSON without failing delivery', async () => {
    const body = '['.repeat(10000) + '0' + ']'.repeat(10000)
    const description = await renderedDescription(body)
    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description.startsWith('```json\n[')).toBe(true)
    expect(description).toContain('\n```\n\n*Content truncated*')
  })

  it('preserves JSON arrays and strings containing HTML, backticks, and Unicode', async () => {
    const value = [{ text: '<p>keep</p><!--visible--><br>\n```\n@everyone \u{1F680}', '`key`': 'https://example.com/' }]
    const description = await renderedDescription(JSON.stringify(value))
    expect(description.startsWith('```json\n[')).toBe(true)
    expect(description.endsWith(']\n```')).toBe(true)
    expect(description.match(/```/g)).toHaveLength(2)
    expect(JSON.parse(description.slice('```json\n'.length, -'\n```'.length))).toEqual(value)
  })

  it('keeps plain summaries and malformed JSON on the text path', async () => {
    const summary = 'The endpoint returned HTTP 200, but expected content was missing.\n\nTarget: https://example.com/'
    expect(await renderedDescription(summary)).toBe(summary)
    for (const body of ['{"invalid":}', '[] extra', 'null', '42', '"text"']) {
      expect(await renderedDescription(body)).toBe(body)
    }
  })

  it('closes truncated JSON fences and puts the continuation notice outside the block', async () => {
    const body = JSON.stringify({ text: '\u{1F680}'.repeat(3000) })
    for (const options of [{ url: baseEvent.url }, {}]) {
      const description = await renderedDescription(body, options)
      expect(description.length).toBeLessThanOrEqual(4096)
      expect(description.startsWith('```json\n')).toBe(true)
      expect(description.match(/```/g)).toHaveLength(2)
      expect(description).toContain('\n```\n\n*Content truncated')
      expect(description).not.toMatch(/[\uD800-\uDBFF]\n```/)
      expect(description.endsWith('*Content truncated*')).toBe(true)
      expect(description).not.toContain('open the title')
    }
  })

  it('does not let removed HTML comments form another comment delimiter', async () => {
    const description = await renderedDescription('before <!<!-- hidden -->-- after')
    const unterminated = await renderedDescription('visible<!-- hidden')

    expect(description).toBe('before <! -- after')
    expect(description).not.toContain('<!--')
    expect(unterminated).toBe('visible')
  })

  it('truncates descriptions at a clean boundary with a continuation notice', async () => {
    const visibleBody = 'x'.repeat(4000)
    const compatibilityBadge = `[![Dependabot compatibility score](https://example.com/${'y'.repeat(500)})]`
    const description = await renderedDescription(`${visibleBody}\n${compatibilityBadge}`)

    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description).toBe(`${visibleBody}\n\n*Content truncated; open the title for the full event*`)
    expect(description).not.toContain('https://example.com')
  })

  it('uses a standalone truncation notice when the event has no URL', async () => {
    const description = await renderedDescription('x'.repeat(5000), {})

    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description).toMatch(/\*Content truncated\*$/)
  })

  it('does not split Unicode characters at the truncation boundary', async () => {
    const description = await renderedDescription('\u{1F680}'.repeat(5000))

    expect(description.length).toBeLessThanOrEqual(4096)
    expect(description).not.toMatch(/[\uD800-\uDBFF]\n\n\*Content truncated/)
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
