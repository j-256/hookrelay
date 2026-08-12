import type { Adapter } from '.'
import { hmacSha256Hex, timingSafeEqualHex } from '../lib/hmac'
import type { Env } from '../index'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, Severity, Subscription } from '../types'

const ADVISORY_SEVERITY: Record<string, Severity> = {
  low: 'info',
  moderate: 'warning',
  high: 'error',
  critical: 'critical',
}

const WORKFLOW_CONCLUSION_SEVERITY: Record<string, Severity> = {
  action_required: 'error',
  cancelled: 'warning',
  failure: 'error',
  neutral: 'info',
  skipped: 'info',
  stale: 'warning',
  success: 'info',
  timed_out: 'error',
}

const NON_TERMINAL_WORKFLOW_ACTIONS = new Set(['requested', 'in_progress'])

interface GitHubSummary {
  type: string
  title: string
  body: string
  url?: string
  severity?: Severity
  shouldDeliver?: boolean
}

function summarize(eventName: string, payload: any): GitHubSummary {
  const action = typeof payload?.action === 'string' ? payload.action : 'event'
  const repo = typeof payload?.repository?.full_name === 'string' ? payload.repository.full_name : '(unknown)'
  const type = `${eventName}.${action}`

  if (eventName === 'issues' && payload?.issue) {
    return {
      type,
      title: `${repo} #${payload.issue.number}: ${payload.issue.title}`,
      body: typeof payload.issue.body === 'string' ? payload.issue.body : '',
      url: payload.issue.html_url,
      severity: 'info',
    }
  }
  if (eventName === 'pull_request' && payload?.pull_request) {
    return {
      type,
      title: `${repo} #${payload.pull_request.number}: ${payload.pull_request.title}`,
      body: typeof payload.pull_request.body === 'string' ? payload.pull_request.body : '',
      url: payload.pull_request.html_url,
      severity: 'info',
    }
  }
  if (eventName === 'security_advisory' && payload?.security_advisory) {
    const adv = payload.security_advisory
    return {
      type,
      title: `[security] ${adv.summary}`,
      body: typeof adv.description === 'string' ? adv.description : '',
      url: adv.html_url,
      severity: ADVISORY_SEVERITY[adv.severity] ?? 'warning',
    }
  }
  if (eventName === 'workflow_run' && payload?.workflow_run) {
    const run = payload.workflow_run
    const state = typeof run.conclusion === 'string'
      ? run.conclusion
      : typeof run.status === 'string' ? run.status : action
    const workflowName = typeof run.name === 'string' ? run.name : 'workflow'
    const displayTitle = typeof run.display_title === 'string' ? run.display_title : ''
    const branch = typeof run.head_branch === 'string' ? run.head_branch : ''
    return {
      type,
      title: `${repo}: ${workflowName} ${state}`,
      body: [displayTitle, branch ? `Branch: ${branch}` : ''].filter(Boolean).join('\n'),
      url: typeof run.html_url === 'string' ? run.html_url : undefined,
      severity: WORKFLOW_CONCLUSION_SEVERITY[state] ?? 'info',
      shouldDeliver: !NON_TERMINAL_WORKFLOW_ACTIONS.has(action),
    }
  }
  // Generic fallback for unknown event types -- still produces a usable normalized event
  return {
    type,
    title: `${repo}: ${type}`,
    body: '',
    severity: 'info',
  }
}

const adapter: Adapter = {
  sourceType: 'github',

  async verify(req: Request, raw: Uint8Array, sub: Subscription, env: Env): Promise<void> {
    if (!sub.auth) throw new Error('github adapter requires sub.auth')
    const header = req.headers.get('x-hub-signature-256')
    if (!header || !header.startsWith('sha256=')) {
      throw new Error('missing x-hub-signature-256')
    }
    const provided = header.slice('sha256='.length)
    const secret = readSecret(env, sub.auth.secretEnv)
    const expected = await hmacSha256Hex(secret, raw)
    if (!timingSafeEqualHex(expected, provided)) {
      throw new Error('signature mismatch')
    }
  },

  async parse(req: Request, raw: Uint8Array, sub: Subscription): Promise<NormalizedEvent> {
    const eventName = req.headers.get('x-github-event')
    if (!eventName) throw new Error('missing x-github-event header')
    const deliveryId = req.headers.get('x-github-delivery')
    if (!deliveryId) throw new Error('missing x-github-delivery header')

    const payload = JSON.parse(new TextDecoder().decode(raw)) as any
    const summary = summarize(eventName, payload)
    return {
      source: 'github',
      subName: sub.name,
      type: summary.type,
      id: deliveryId,
      timestamp: new Date().toISOString(),
      title: summary.title,
      body: summary.body,
      url: summary.url,
      severity: summary.severity,
      shouldDeliver: summary.shouldDeliver,
      raw: payload,
    }
  },
}

export default adapter
