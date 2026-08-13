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

  it('formats star and watcher activity as useful notifications', async () => {
    const repository = {
      full_name: 'example-owner/example-repo',
      html_url: 'https://github.com/example-owner/example-repo',
    }
    const sender = { login: 'octocat' }
    const starred = await makeReq({ action: 'created', repository, sender }, 'star', { deliveryId: 'star-1' })
    const watched = await makeReq({ action: 'started', repository, sender }, 'watch', { deliveryId: 'watch-1' })

    const starEvent = await github.parse(starred.req, starred.raw, sub)
    const watchEvent = await github.parse(watched.req, watched.raw, sub)
    expect(starEvent.title).toBe('example-owner/example-repo: octocat starred the repository')
    expect(starEvent.url).toBe('https://github.com/example-owner/example-repo/stargazers')
    expect(watchEvent.title).toBe('example-owner/example-repo: octocat started watching the repository')
    expect(watchEvent.url).toBe('https://github.com/example-owner/example-repo/watchers')
  })

  it('marks ping events as record-only', async () => {
    const payload = {
      zen: 'Keep it logically awesome.',
      hook_id: 123,
      repository: { full_name: 'example-owner/example-repo' },
    }
    const { req, raw } = await makeReq(payload, 'ping', { deliveryId: 'ping-1' })
    const event = await github.parse(req, raw, sub)
    expect(event.type).toBe('ping.event')
    expect(event.shouldDeliver).toBe(false)
  })

  it('throws when X-GitHub-Delivery is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    const stripped = new Request(req)
    stripped.headers.delete('x-github-delivery')
    await expect(github.parse(stripped, raw, sub)).rejects.toThrow(/delivery/i)
  })

  it('records non-terminal workflow runs without delivering them to sinks', async () => {
    const payload = {
      action: 'in_progress',
      repository: { full_name: 'example-owner/example-repo' },
      workflow_run: {
        name: 'Deploy',
        display_title: 'Publish site',
        head_branch: 'main',
        status: 'in_progress',
        conclusion: null,
        html_url: 'https://github.com/example-owner/example-repo/actions/runs/123',
      },
    }
    const { req, raw } = await makeReq(payload, 'workflow_run', { deliveryId: 'd-3' })
    const event = await github.parse(req, raw, sub)
    expect(event.type).toBe('workflow_run.in_progress')
    expect(event.shouldDeliver).toBe(false)
    expect(event.title).toBe('example-owner/example-repo: Deploy in_progress')
  })

  it('delivers completed workflow runs with a conclusion-derived severity', async () => {
    const payload = {
      action: 'completed',
      repository: { full_name: 'example-owner/example-repo' },
      workflow_run: {
        name: 'Deploy',
        display_title: 'Publish site',
        head_branch: 'main',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/example-owner/example-repo/actions/runs/123',
      },
    }
    const { req, raw } = await makeReq(payload, 'workflow_run', { deliveryId: 'd-4' })
    const event = await github.parse(req, raw, sub)
    expect(event.shouldDeliver).toBe(true)
    expect(event.severity).toBe('error')
    expect(event.url).toContain('/actions/runs/123')
  })
})
