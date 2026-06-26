import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import cloudflare from '../../../src/adapters/cloudflare'
import type { Subscription } from '../../../src/types'
import ddosStart from '../../fixtures/cloudflare/ddos-start.json'

const SECRET_NAME = 'HMAC_CF_TEST'
const SECRET_VALUE = 'cf-shared-secret'
;(env as unknown as Record<string, string>)[SECRET_NAME] = SECRET_VALUE

const sub: Subscription = {
  name: 'cf-fleet',
  source: 'cloudflare-notifications',
  enabled: true,
  sinks: [],
  auth: { scheme: 'cf-shared-secret', secretEnv: SECRET_NAME },
}

const makeReq = (body: unknown, opts: { authHeader?: string | null } = {}) => {
  const raw = new TextEncoder().encode(JSON.stringify(body))
  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.authHeader === undefined) {
    headers.set('cf-webhook-auth', SECRET_VALUE)
  } else if (opts.authHeader !== null) {
    headers.set('cf-webhook-auth', opts.authHeader)
  }
  return { req: new Request('https://hooks.example.com/hook/cloudflare-notifications/abc', { method: 'POST', body: raw, headers }), raw }
}

describe('cloudflare adapter verify', () => {
  it('passes for matching shared secret', async () => {
    const { req, raw } = makeReq(ddosStart)
    await expect(cloudflare.verify(req, raw, sub, env)).resolves.toBeUndefined()
  })

  it('rejects when header is missing', async () => {
    const { req, raw } = makeReq(ddosStart, { authHeader: null })
    await expect(cloudflare.verify(req, raw, sub, env)).rejects.toThrow(/cf-webhook-auth/)
  })

  it('rejects when header value differs', async () => {
    const { req, raw } = makeReq(ddosStart, { authHeader: 'wrong' })
    await expect(cloudflare.verify(req, raw, sub, env)).rejects.toThrow(/mismatch/)
  })

  it('rejects when sub.auth is null', async () => {
    const { req, raw } = makeReq(ddosStart)
    await expect(cloudflare.verify(req, raw, { ...sub, auth: null }, env)).rejects.toThrow(/auth/)
  })
})

describe('cloudflare adapter parse', () => {
  it('produces a stable id from content hash', async () => {
    const { req, raw } = makeReq(ddosStart)
    const a = await cloudflare.parse(req, raw, sub)
    const b = await cloudflare.parse(req, raw, sub)
    expect(a.id).toBe(b.id)
    expect(a.id.length).toBeGreaterThan(0)
  })

  it('produces a different id when ts differs', async () => {
    const { req: req1, raw: raw1 } = makeReq(ddosStart)
    const { req: req2, raw: raw2 } = makeReq({ ...ddosStart, ts: ddosStart.ts + 1 })
    const a = await cloudflare.parse(req1, raw1, sub)
    const b = await cloudflare.parse(req2, raw2, sub)
    expect(a.id).not.toBe(b.id)
  })

  it('maps alert_type and produces title from name', async () => {
    const { req, raw } = makeReq(ddosStart)
    const event = await cloudflare.parse(req, raw, sub)
    expect(event.type).toBe('dos_attack_l7')
    expect(event.title).toContain('DDoS Attack Detected')
    expect(event.body).toContain('status.example.com')
  })

  it('marks ALERT_STATE_EVENT_END events as info severity', async () => {
    const payload = { ...ddosStart, alert_event: 'ALERT_STATE_EVENT_END' }
    const { req, raw } = makeReq(payload)
    const event = await cloudflare.parse(req, raw, sub)
    expect(event.severity).toBe('info')
  })
})
