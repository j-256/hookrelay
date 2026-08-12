import { describe, expect, it } from 'vitest'
import {
  discoverWorkerBaseUrl,
  selectWorkerBaseUrl,
  workerNameFromWrangler,
} from '../../scripts/cloudflare-domains'

describe('workerNameFromWrangler', () => {
  it('reads the Worker name from JSONC', () => {
    expect(workerNameFromWrangler('{ // comment\n "name": "hookrelay",\n}')).toBe('hookrelay')
  })

  it('rejects malformed or unnamed config', () => {
    expect(() => workerNameFromWrangler('{')).toThrow(/invalid/)
    expect(() => workerNameFromWrangler('{}')).toThrow(/no Worker name/)
  })
})

describe('selectWorkerBaseUrl', () => {
  it('selects the one enabled production domain for the Worker', () => {
    expect(selectWorkerBaseUrl([
      { hostname: 'hooks.example.com', service: 'hookrelay', environment: 'production', enabled: true },
      { hostname: 'preview.example.com', service: 'hookrelay', environment: 'preview', enabled: true },
      { hostname: 'other.example.com', service: 'other', environment: 'production', enabled: true },
    ], 'hookrelay')).toBe('https://hooks.example.com')
  })

  it('requires an explicit URL for zero or multiple domains', () => {
    expect(() => selectWorkerBaseUrl([], 'hookrelay')).toThrow(/no production custom domain/)
    expect(() => selectWorkerBaseUrl([
      { hostname: 'one.example.com', service: 'hookrelay' },
      { hostname: 'two.example.com', service: 'hookrelay' },
    ], 'hookrelay')).toThrow(/multiple custom domains/)
  })
})

describe('discoverWorkerBaseUrl', () => {
  it('queries the Cloudflare Worker domains endpoint without exposing credentials', async () => {
    let requestUrl: string | URL | Request | undefined
    let requestInit: RequestInit | undefined
    const fetchFn: typeof fetch = async (input, init) => {
      requestUrl = input
      requestInit = init
      return Response.json({
        success: true,
        result: [{ hostname: 'hooks.example.com', service: 'hookrelay', environment: 'production' }],
      })
    }
    await expect(discoverWorkerBaseUrl({
      accountId: 'account-id',
      apiToken: 'api-token',
      configText: '{ "name": "hookrelay" }',
      fetchFn,
    })).resolves.toBe('https://hooks.example.com')

    const url = new URL(String(requestUrl))
    expect(url.pathname).toBe('/client/v4/accounts/account-id/workers/domains')
    expect(url.searchParams.get('service')).toBe('hookrelay')
    expect(url.searchParams.get('environment')).toBe('production')
    expect(requestInit?.headers).toEqual({ authorization: 'Bearer api-token' })
  })

  it('requires discovery credentials and reports Cloudflare failures', async () => {
    await expect(discoverWorkerBaseUrl({
      accountId: '',
      apiToken: '',
      configText: '{ "name": "hookrelay" }',
    })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/)

    await expect(discoverWorkerBaseUrl({
      accountId: 'account-id',
      apiToken: 'api-token',
      configText: '{ "name": "hookrelay" }',
      fetchFn: async () => Response.json(
        { success: false, errors: [{ message: 'not authorized' }] },
        { status: 403 },
      ),
    })).rejects.toThrow(/not authorized/)

    await expect(discoverWorkerBaseUrl({
      accountId: 'account-id',
      apiToken: 'api-token',
      configText: '{ "name": "hookrelay" }',
      fetchFn: async () => { throw new Error('network details') },
    })).rejects.toThrow('Cloudflare domains request failed; pass --base-url')
  })
})
