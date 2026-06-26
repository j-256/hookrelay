import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import ntfy from '../../../src/sinks/ntfy'
import type { NormalizedEvent } from '../../../src/types'

const baseEvent: NormalizedEvent = {
  source: 'fixture',
  subName: 'fixture-sub',
  type: 'fixture.event',
  id: 'evt-1',
  timestamp: '2026-06-06T00:00:00.000Z',
  title: 'Hello',
  body: 'world',
  url: 'https://example.com/event/1',
  severity: 'warning',
  raw: {},
}

describe('ntfy sink', () => {
  it('config schema accepts {topic} and rejects extras', () => {
    expect(() => ntfy.configSchema.parse({ topic: 't' })).not.toThrow()
    expect(() => ntfy.configSchema.parse({})).toThrow()
  })

  it('POSTs to ntfy.sh/{topic} with title, click, and priority headers', async () => {
    const fetchMock = vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      expect(url).toBe('https://ntfy.sh/my-topic')
      const headers = new Headers(init?.headers)
      expect(headers.get('Title')).toBe('Hello')
      expect(headers.get('Click')).toBe('https://example.com/event/1')
      expect(headers.get('Priority')).toBe('3') // warning
      expect(typeof init?.body === 'string' && init.body).toContain('world')
      return new Response('ok', { status: 200 })
    })
    await ntfy.send(baseEvent, { topic: 'my-topic' }, env, fetchMock as unknown as typeof fetch)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps severity to ntfy priority correctly', async () => {
    const cases: Array<[NormalizedEvent['severity'], string]> = [
      ['debug', '1'],
      ['info', '2'],
      ['warning', '3'],
      ['error', '4'],
      ['critical', '5'],
    ]
    for (const [severity, expected] of cases) {
      const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('Priority')).toBe(expected)
        return new Response('ok', { status: 200 })
      })
      await ntfy.send({ ...baseEvent, severity }, { topic: 't' }, env, fetchMock as unknown as typeof fetch)
    }
  })

  it('omits Click header when event.url is missing', async () => {
    const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Click')).toBeNull()
      return new Response('ok', { status: 200 })
    })
    await ntfy.send({ ...baseEvent, url: undefined }, { topic: 't' }, env, fetchMock as unknown as typeof fetch)
  })

  it('throws on non-2xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }))
    await expect(ntfy.send(baseEvent, { topic: 't' }, env, fetchMock as unknown as typeof fetch)).rejects.toThrow(/500/)
  })
})
