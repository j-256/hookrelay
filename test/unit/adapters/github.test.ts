import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import github from '../../../src/adapters/github'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import type { Subscription } from '../../../src/types'
import issuesOpened from '../../fixtures/github/issues-opened.json'
import advisoryCritical from '../../fixtures/github/security-advisory-critical.json'

const SECRET_NAME = 'HMAC_GITHUB_TEST'
const SECRET_VALUE = 'shhh'
const ALTERNATE_SECRET_NAME = 'HMAC_GITHUB_TEST_ALTERNATE'
const ALTERNATE_SECRET_VALUE = 'also-shhh'
;(env as unknown as Record<string, string>)[SECRET_NAME] = SECRET_VALUE
;(env as unknown as Record<string, string>)[ALTERNATE_SECRET_NAME] = ALTERNATE_SECRET_VALUE

const sub: Subscription = {
  name: 'github-test',
  source: 'github',
  enabled: true,
  sinks: [],
  auth: { scheme: 'github-sha256', secretEnv: SECRET_NAME },
}

const makeReq = async (
  body: unknown,
  eventName: string,
  opts: { sign?: boolean; deliveryId?: string; secret?: string } = {},
) => {
  const raw = new TextEncoder().encode(JSON.stringify(body))
  const headers = new Headers({
    'content-type': 'application/json',
    'x-github-event': eventName,
    'x-github-delivery': opts.deliveryId ?? '11111111-2222-3333-4444-555555555555',
  })
  if (opts.sign !== false) {
    const sig = await hmacSha256Hex(opts.secret ?? SECRET_VALUE, raw)
    headers.set('x-hub-signature-256', `sha256=${sig}`)
  }
  return { req: new Request('https://hooks.example.com/hook/github/abc', { method: 'POST', body: raw, headers }), raw }
}

describe('github adapter verify', () => {
  it('passes for a correctly signed body', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    await expect(github.verify(req, raw, sub, env)).resolves.toBeUndefined()
  })

  it('passes when an alternate secret signs the body', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues', { secret: ALTERNATE_SECRET_VALUE })
    const rotatingSub = {
      ...sub,
      auth: {
        scheme: 'github-sha256',
        secretEnv: SECRET_NAME,
        alternateSecretEnvs: [ALTERNATE_SECRET_NAME],
      },
    }
    await expect(github.verify(req, raw, rotatingSub, env)).resolves.toBeUndefined()
  })

  it('passes with an available alternate when the primary secret is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues', { secret: ALTERNATE_SECRET_VALUE })
    const rotatingSub = {
      ...sub,
      auth: {
        scheme: 'github-sha256',
        secretEnv: 'DOES_NOT_EXIST',
        alternateSecretEnvs: [ALTERNATE_SECRET_NAME],
      },
    }
    await expect(github.verify(req, raw, rotatingSub, env)).resolves.toBeUndefined()
  })

  it('passes with the primary when an alternate secret is missing', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    const rotatingSub = {
      ...sub,
      auth: {
        scheme: 'github-sha256',
        secretEnv: SECRET_NAME,
        alternateSecretEnvs: ['DOES_NOT_EXIST'],
      },
    }
    await expect(github.verify(req, raw, rotatingSub, env)).resolves.toBeUndefined()
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

  it('rejects when no configured secret env is available', async () => {
    const { req, raw } = await makeReq(issuesOpened, 'issues')
    await expect(
      github.verify(req, raw, {
        ...sub,
        auth: {
          scheme: 'github-sha256',
          secretEnv: 'DOES_NOT_EXIST',
          alternateSecretEnvs: ['ALSO_DOES_NOT_EXIST'],
        },
      }, env),
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

  it('formats push activity with ref, actor, commit summary, and comparison URL', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: '1234567890abcdef',
      created: false,
      deleted: false,
      forced: false,
      compare: 'https://github.com/example-owner/example-repo/compare/before...after',
      commits: [{ id: '1' }, { id: '2' }],
      head_commit: { message: 'Improve the home page\n\nMore detail' },
      repository: { full_name: 'example-owner/example-repo', html_url: 'https://github.com/example-owner/example-repo' },
      sender: { login: 'example-owner' },
    }
    const { req, raw } = await makeReq(payload, 'push', { deliveryId: 'push-1' })
    const event = await github.parse(req, raw, sub)

    expect(event).toMatchObject({
      type: 'push.updated',
      title: 'example-owner/example-repo: example-owner pushed 2 commits to main',
      body: 'Improve the home page\nHead: 1234567',
      url: 'https://github.com/example-owner/example-repo/compare/before...after',
      severity: 'info',
    })
  })

  it('raises forced and deleted pushes to warning severity', async () => {
    const repository = { full_name: 'example-owner/example-repo', html_url: 'https://github.com/example-owner/example-repo' }
    const sender = { login: 'example-owner' }
    const forced = await makeReq({
      ref: 'refs/heads/main',
      forced: true,
      commits: [{ id: '1' }],
      repository,
      sender,
    }, 'push')
    const deleted = await makeReq({
      ref: 'refs/tags/old',
      deleted: true,
      commits: [],
      repository,
      sender,
    }, 'push')

    await expect(github.parse(forced.req, forced.raw, sub)).resolves.toMatchObject({
      type: 'push.forced',
      severity: 'warning',
    })
    await expect(github.parse(deleted.req, deleted.raw, sub)).resolves.toMatchObject({
      type: 'push.deleted',
      title: 'example-owner/example-repo: example-owner deleted tag old',
      severity: 'warning',
    })
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

  it('records workflow jobs until completion and delivers failed jobs as errors', async () => {
    const repository = { full_name: 'example-owner/example-repo' }
    const queued = await makeReq({
      action: 'queued',
      repository,
      workflow_job: { name: 'build', status: 'queued', head_branch: 'main' },
    }, 'workflow_job')
    const completed = await makeReq({
      action: 'completed',
      repository,
      workflow_job: {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        head_branch: 'main',
        runner_name: 'GitHub Actions 1',
        html_url: 'https://github.com/example-owner/example-repo/actions/runs/123/job/456',
      },
    }, 'workflow_job')

    await expect(github.parse(queued.req, queued.raw, sub)).resolves.toMatchObject({ shouldDeliver: false })
    await expect(github.parse(completed.req, completed.raw, sub)).resolves.toMatchObject({
      title: 'example-owner/example-repo: build failure',
      severity: 'error',
      shouldDeliver: true,
    })
  })

  it('records deployment creation and transient states but delivers terminal failures', async () => {
    const repository = { full_name: 'example-owner/example-repo', html_url: 'https://github.com/example-owner/example-repo' }
    const deployment = { environment: 'github-pages', ref: 'main', sha: '1234567890abcdef' }
    const created = await makeReq({ action: 'created', repository, deployment }, 'deployment')
    const waiting = await makeReq({
      action: 'created',
      repository,
      deployment,
      deployment_status: { state: 'waiting', environment: 'github-pages' },
    }, 'deployment_status')
    const failed = await makeReq({
      action: 'created',
      repository,
      deployment,
      deployment_status: {
        state: 'failure',
        environment: 'github-pages',
        description: 'Pages deployment failed',
        log_url: 'https://github.com/example-owner/example-repo/actions/runs/123',
      },
    }, 'deployment_status')

    await expect(github.parse(created.req, created.raw, sub)).resolves.toMatchObject({
      title: 'example-owner/example-repo: github-pages deployment created',
      shouldDeliver: false,
    })
    await expect(github.parse(waiting.req, waiting.raw, sub)).resolves.toMatchObject({
      type: 'deployment_status.waiting',
      shouldDeliver: false,
    })
    await expect(github.parse(failed.req, failed.raw, sub)).resolves.toMatchObject({
      type: 'deployment_status.failure',
      title: 'example-owner/example-repo: github-pages deployment failure',
      severity: 'error',
      shouldDeliver: true,
      url: 'https://github.com/example-owner/example-repo/actions/runs/123',
    })
  })

  it('suppresses non-terminal Pages builds and delivers build errors', async () => {
    const repository = { full_name: 'example-owner/example-repo', html_url: 'https://github.com/example-owner/example-repo' }
    const building = await makeReq({ repository, build: { status: 'building' } }, 'page_build')
    const errored = await makeReq({
      repository,
      build: { status: 'errored', commit: '1234567890abcdef', error: { message: 'Build failed' } },
    }, 'page_build')

    await expect(github.parse(building.req, building.raw, sub)).resolves.toMatchObject({ shouldDeliver: false })
    await expect(github.parse(errored.req, errored.raw, sub)).resolves.toMatchObject({
      type: 'page_build.errored',
      body: 'Build failed\nCommit: 1234567',
      severity: 'error',
      shouldDeliver: true,
    })
  })

  it('maps code scanning alerts to rule severity and informational closure events', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'example-owner/example-repo' },
      ref: 'refs/heads/main',
      alert: {
        number: 7,
        state: 'open',
        html_url: 'https://github.com/example-owner/example-repo/security/code-scanning/7',
        rule: { description: 'DOM text reinterpreted as HTML', severity: 'error' },
      },
    }
    const created = await makeReq(payload, 'code_scanning_alert')
    const fixed = await makeReq({ ...payload, action: 'fixed', alert: { ...payload.alert, state: 'fixed' } }, 'code_scanning_alert')

    await expect(github.parse(created.req, created.raw, sub)).resolves.toMatchObject({
      title: '[security] example-owner/example-repo: DOM text reinterpreted as HTML (created)',
      body: 'Severity: error\nRef: refs/heads/main\nState: open',
      severity: 'error',
    })
    await expect(github.parse(fixed.req, fixed.raw, sub)).resolves.toMatchObject({ severity: 'info' })
  })

  it('formats Dependabot findings with remediation details', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'example-owner/example-repo' },
      alert: {
        number: 3,
        state: 'open',
        html_url: 'https://github.com/example-owner/example-repo/security/dependabot/3',
        dependency: { package: { name: 'astro' }, manifest_path: 'package-lock.json' },
        security_advisory: { summary: 'Example vulnerability', severity: 'critical' },
        security_vulnerability: {
          vulnerable_version_range: '< 6.4.0',
          first_patched_version: { identifier: '6.4.0' },
        },
      },
    }
    const created = await makeReq(payload, 'dependabot_alert')
    const fixed = await makeReq({ ...payload, action: 'fixed' }, 'dependabot_alert')

    await expect(github.parse(created.req, created.raw, sub)).resolves.toMatchObject({
      title: '[security] example-owner/example-repo: astro created',
      body: 'Example vulnerability\nSeverity: critical\nVulnerable: < 6.4.0\nPatched: 6.4.0\nManifest: package-lock.json',
      severity: 'critical',
    })
    await expect(github.parse(fixed.req, fixed.raw, sub)).resolves.toMatchObject({ severity: 'info' })
  })

  it('formats secret scanning alerts without exposing the secret value', async () => {
    const payload = {
      action: 'created',
      repository: { full_name: 'example-owner/example-repo' },
      alert: {
        number: 5,
        state: 'open',
        validity: 'active',
        secret_type: 'github_personal_access_token',
        secret_type_display_name: 'GitHub personal access token',
        secret: 'never-render-this-value',
        push_protection_bypassed: true,
        html_url: 'https://github.com/example-owner/example-repo/security/secret-scanning/5',
      },
    }
    const created = await makeReq(payload, 'secret_scanning_alert')
    const resolved = await makeReq({
      ...payload,
      action: 'resolved',
      alert: { ...payload.alert, state: 'resolved', resolution: 'revoked' },
    }, 'secret_scanning_alert')
    const createdEvent = await github.parse(created.req, created.raw, sub)
    const resolvedEvent = await github.parse(resolved.req, resolved.raw, sub)

    expect(createdEvent).toMatchObject({
      title: '[security] example-owner/example-repo: GitHub personal access token created',
      body: 'State: open\nValidity: active\nPush protection bypassed: yes',
      severity: 'critical',
    })
    expect(`${createdEvent.title}\n${createdEvent.body}`).not.toContain(payload.alert.secret)
    expect(resolvedEvent).toMatchObject({ severity: 'info' })
  })

  it('formats repository advisories using the repository webhook payload shape', async () => {
    const payload = {
      action: 'published',
      repository: { full_name: 'example-owner/example-repo' },
      repository_advisory: {
        summary: 'Unsafe rendering in older releases',
        description: 'Upgrade to the fixed release',
        severity: 'critical',
        html_url: 'https://github.com/example-owner/example-repo/security/advisories/GHSA-example',
      },
    }
    const { req, raw } = await makeReq(payload, 'repository_advisory')

    await expect(github.parse(req, raw, sub)).resolves.toMatchObject({
      title: '[security] example-owner/example-repo: Unsafe rendering in older releases',
      body: 'Upgrade to the fixed release\nSeverity: critical',
      severity: 'critical',
      url: 'https://github.com/example-owner/example-repo/security/advisories/GHSA-example',
    })
  })

  it('formats secret locations and security configuration changes', async () => {
    const repository = { full_name: 'example-owner/example-repo', html_url: 'https://github.com/example-owner/example-repo' }
    const location = await makeReq({
      action: 'created',
      repository,
      alert: {
        number: 5,
        state: 'open',
        secret_type_display_name: 'GitHub personal access token',
        html_url: 'https://github.com/example-owner/example-repo/security/secret-scanning/5',
      },
      location: { type: 'commit', details: { path: 'src/config.ts' } },
    }, 'secret_scanning_alert_location')
    const settings = await makeReq({
      repository,
      changes: { secret_scanning: { from: { status: 'disabled' } } },
    }, 'security_and_analysis')

    await expect(github.parse(location.req, location.raw, sub)).resolves.toMatchObject({
      title: '[security] example-owner/example-repo: new location for GitHub personal access token',
      body: 'Location type: commit\nPath: src/config.ts\nState: open',
      severity: 'critical',
    })
    await expect(github.parse(settings.req, settings.raw, sub)).resolves.toMatchObject({
      title: '[security] example-owner/example-repo: security settings changed',
      body: 'Changed: secret_scanning',
      severity: 'warning',
    })
  })

  it('records secret scanning completion without delivering it', async () => {
    const payload = {
      action: 'completed',
      repository: { full_name: 'example-owner/example-repo' },
      type: 'pattern-version-backfill',
      source: 'git',
    }
    const { req, raw } = await makeReq(payload, 'secret_scanning_scan')

    await expect(github.parse(req, raw, sub)).resolves.toMatchObject({
      body: 'Scan type: pattern-version-backfill\nSource: git',
      shouldDeliver: false,
    })
  })
})
