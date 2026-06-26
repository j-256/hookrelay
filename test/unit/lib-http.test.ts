import { describe, expect, it, vi } from 'vitest'
import { postJson, postRaw } from '../../src/lib/http'

describe('postJson', () => {
  it('issues POST with JSON body and parses content-type from response', async () => {
    const fetchMock = vi.fn(async (_input: Request | string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      expect(body).toContain('"hello":"world"')
      expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
      return new Response('ok', { status: 200 })
    })
    const res = await postJson('https://example.com/x', { hello: 'world' }, { fetch: fetchMock as unknown as typeof fetch })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(res.status).toBe(200)
  })

  it('throws if response status >= 400', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 }))
    await expect(postJson('https://example.com/x', {}, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/502/)
  })
})

describe('postRaw', () => {
  it('issues POST with the provided body and headers', async () => {
    const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      expect(url).toBe('https://example.com/raw')
      expect(init?.body).toBe('hello world')
      const headers = new Headers(init?.headers)
      expect(headers.get('X-Custom')).toBe('yes')
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    const res = await postRaw('https://example.com/raw', 'hello world', { headers: { 'X-Custom': 'yes' }, fetch: fetchMock })
    expect(res.status).toBe(200)
  })

  it('throws if response status >= 400', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 502 })) as unknown as typeof fetch
    await expect(postRaw('https://example.com/raw', 'body', { fetch: fetchMock })).rejects.toThrow(/502/)
  })
})
