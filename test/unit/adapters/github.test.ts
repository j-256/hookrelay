import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import github from '../../../src/adapters/github'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import type { Subscription } from '../../../src/types'
import issuesOpened from '../../fixtures/github/issues-opened.json'
import advisoryCritical from '../../fixtures/github/security-advisory-critical.json'

const SECRET_NAME = 'HMAC_GITHUB_TEST'
const SECRET_VALUE = 'shhh'
;(env as unknown as Record<string, string>)[SECRET_NAME] = SECRET_VALUE

const sub: Subscription = {
  name: 'github-test',
  source: 'github',
  enabled: true,
  sinks: [],
  auth: { scheme: 'github-sha256', secretEnv: SECRET_NAME },
}

const makeReq = async (body: unknown, eventName: string, opts: { sign?: boolean; deliveryId?: string } = {}) => {
  const raw = new TextEncoder().encode(JSON.stringify(body))
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-event': eventName,
    'x-github-delivery': opts.deliveryId ?? '11111111-2222-3333-4444-555555555555',
  })
  if (opts.sign !== false) {
    const sig = await hmacSha256Hex(SECRET_VALUE, raw)
    headers.set('x-hub-signature-256', `sha256=${sig}`)
  }
  return { req: new Request('https://hooks.example.com/hook/github/abc', { method: 'POST', body: raw, headers }), raw }
}

describe('github adapter verify', () => {
  it('passes for a correctly signed body', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    await expect(github.verify(req, raw, sub, env)).resolves.toBeUndefined()
  })

  it('rejects when signature is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues', { sign: false })
    await expect(github.verify(req, raw, sub, env)).rejects.toThrow(/signature/)
  })

  it('rejects when signature is wrong', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    const tampered = new Request(req, { headers: new Headers([...req.headers, ['x-hub-signature-256', 'sha256=' + '0'.repeat(64)]]) })
    await expect(github.verify(tampered, raw, sub, env)).rejects.toThrow(/signature/)
  })

  it('rejects when sub.auth is null', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    await expect(github.verify(req, raw, { ...sub, auth: null }, env)).rejects.toThrow(/auth/)
  })

  it('rejects when secret env is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    await expect(
      github.verify(req, raw, { ...sub, auth: { scheme: 'github-sha256', secretEnv: 'DOES_NOT_EXIST' } }, env),
    ).rejects.toThrow(/secret/)
  })
})

describe('github adapter parse', () => {
  it('parses issues.opened', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues', { deliveryId: 'd-1' })
    const event = await github.parse(req, raw, sub)
    expect(event.source).toBe('github')
    expect(event.type).toBe('issues.opened')
    expect(event.id).toBe('d-1')
    expect(event.title).toContain('octo-org/example-repo')
    expect(event.title).toContain('Build is broken')
    expect(event.url).toContain('/issues/42')
    expect(event.severity).toBe('info')
  })

  it('parses security_advisory.published with critical severity', async () => {
    const { req, raw } = await makeReq(advisoryCritical, 'security_advisory', { deliveryId: 'd-2' })
    const event = await github.parse(req, raw, sub)
    expect(event.type).toBe('security_advisory.published')
    expect(event.id).toBe('d-2')
    expect(event.severity).toBe('critical')
  })

  it('throws when X-GitHub-Delivery is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    const stripped = new Request(req)
    stripped.headers.delete('x-github-delivery')
    await expect(github.parse(stripped, raw, sub)).rejects.toThrow(/delivery/i)
  })
})
