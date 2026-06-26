import { describe, expect, it, vi } from 'vitest'
import { verifyAccessJwt } from '../../../src/admin/access'

const TEAM = 'fake-team'
const AUD = 'aud-fixture'

// Helper to mint an unsigned JWT shape (we only test the verify-time error paths;
// signature validation is exercised in integration with a real CF Access instance)
function mintShape(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: 'test-kid' }
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc(header)}.${enc(payload)}.fake-sig`
}

describe('verifyAccessJwt', () => {
  it('returns null when header is missing', async () => {
    const req = new Request('https://hooks.example.com/admin/events')
    const result = await verifyAccessJwt(req, {
      teamDomain: TEAM,
      audience: AUD,
      fetch: vi.fn() as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('returns null when JWKS fetch fails', async () => {
    const req = new Request('https://hooks.example.com/admin/events', {
      headers: { 'cf-access-jwt-assertion': mintShape({ aud: AUD, exp: Date.now() / 1000 + 60 }) },
    })
    const result = await verifyAccessJwt(req, {
      teamDomain: TEAM,
      audience: AUD,
      fetch: vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('returns null when audience does not match', async () => {
    const req = new Request('https://hooks.example.com/admin/events', {
      headers: { 'cf-access-jwt-assertion': mintShape({ aud: 'wrong', exp: Date.now() / 1000 + 60 }) },
    })
    const result = await verifyAccessJwt(req, {
      teamDomain: TEAM,
      audience: AUD,
      fetch: vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('returns null when token is expired', async () => {
    const req = new Request('https://hooks.example.com/admin/events', {
      headers: { 'cf-access-jwt-assertion': mintShape({ aud: AUD, exp: 1 }) },
    })
    const result = await verifyAccessJwt(req, {
      teamDomain: TEAM,
      audience: AUD,
      fetch: vi.fn(async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })

  it('returns null on signature failure (no matching kid in JWKS)', async () => {
    const req = new Request('https://hooks.example.com/admin/events', {
      headers: { 'cf-access-jwt-assertion': mintShape({ aud: AUD, exp: Date.now() / 1000 + 60 }) },
    })
    const result = await verifyAccessJwt(req, {
      teamDomain: TEAM,
      audience: AUD,
      fetch: vi.fn(async () => new Response(JSON.stringify({ keys: [{ kid: 'other-kid' }] }), { status: 200 })) as unknown as typeof fetch,
    })
    expect(result).toBeNull()
  })
})
