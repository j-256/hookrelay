import type { Adapter } from '.'
import { hmacSha256Hex, timingSafeEqualHex } from '../lib/hmac'
import type { Env } from '../index'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, Severity, Subscription } from '../types'

const SECURITY_SEVERITY: Record<string, Severity> = {
  critical: 'critical',
  high: 'error',
  medium: 'warning',
  moderate: 'warning',
  low: 'info',
  warning: 'warning',
  note: 'info',
  error: 'error',
}

const WORKFLOW_CONCLUSION_SEVERITY: Record<string, Severity> = {
  action_required: 'error',
  cancelled: 'warning',
  failure: 'error',
  neutral: 'info',
  skipped: 'info',
  stale: 'warning',
  startup_failure: 'error',
  success: 'info',
  timed_out: 'error',
}

const DEPLOYMENT_STATE_SEVERITY: Record<string, Severity> = {
  error: 'error',
  failure: 'error',
  inactive: 'info',
  in_progress: 'info',
  pending: 'info',
  queued: 'info',
  success: 'info',
  waiting: 'info',
}

const NON_TERMINAL_WORKFLOW_ACTIONS = new Set(['in_progress', 'pending', 'queued', 'requested', 'waiting'])
const NON_TERMINAL_DEPLOYMENT_STATES = new Set(['in_progress', 'pending', 'queued', 'waiting'])
const NON_TERMINAL_PAGE_BUILD_STATES = new Set(['building', 'queued'])
const INFORMATIONAL_CODE_SCANNING_ACTIONS = new Set(['closed_by_user', 'fixed'])
const INFORMATIONAL_DEPENDABOT_ACTIONS = new Set(['assignees_changed', 'auto_dismissed', 'dismissed', 'fixed'])
const INFORMATIONAL_SECRET_SCANNING_ACTIONS = new Set(['resolved', 'revoked'])
const CRITICAL_SECRET_SCANNING_ACTIONS = new Set(['created', 'publicly_leaked', 'reopened', 'validated'])
const GITHUB_PING_EVENT = 'ping'
const BRANCH_REF_PREFIX = 'refs/heads/'
const TAG_REF_PREFIX = 'refs/tags/'

interface GitHubSummary {
  type: string
  title: string
  body: string
  url?: string
  severity?: Severity
  shouldDeliver?: boolean
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function firstLine(value: unknown): string | undefined {
  return nonEmptyString(value)?.split(/\r?\n/, 1)[0]
}

function labeled(label: string, value: unknown): string | undefined {
  const text = nonEmptyString(value)
  return text ? `${label}: ${text}` : undefined
}

function bodyLines(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).join('\n')
}

function formatAction(action: string): string {
  return action.replace(/[_-]+/g, ' ')
}

function severityFrom(value: unknown, fallback: Severity = 'warning'): Severity {
  const name = nonEmptyString(value)?.toLowerCase()
  return name ? SECURITY_SEVERITY[name] ?? fallback : fallback
}

function shortSha(value: unknown): string | undefined {
  return nonEmptyString(value)?.slice(0, 7)
}

function repositoryUrl(payload: any): string | undefined {
  return nonEmptyString(payload?.repository?.html_url)
}

function repositoryDeploymentsUrl(payload: any): string | undefined {
  const url = repositoryUrl(payload)
  return url ? `${url}/deployments` : undefined
}

function repositoryPath(payload: any, path: string): string | undefined {
  const url = repositoryUrl(payload)
  return url ? `${url}/${path}` : undefined
}

function refDescription(value: unknown): { kind: 'branch' | 'tag' | 'ref'; name: string } {
  const ref = nonEmptyString(value) ?? '(unknown)'
  if (ref.startsWith(BRANCH_REF_PREFIX)) return { kind: 'branch', name: ref.slice(BRANCH_REF_PREFIX.length) }
  if (ref.startsWith(TAG_REF_PREFIX)) return { kind: 'tag', name: ref.slice(TAG_REF_PREFIX.length) }
  return { kind: 'ref', name: ref }
}

function commitCountText(count: number): string {
  return `${count} ${count === 1 ? 'commit' : 'commits'}`
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
  if (eventName === 'push') {
    const ref = refDescription(payload?.ref)
    const actor = nonEmptyString(payload?.sender?.login) ?? nonEmptyString(payload?.pusher?.name) ?? 'Someone'
    const commits = Array.isArray(payload?.commits) ? payload.commits : []
    const pushAction = payload?.deleted === true
      ? 'deleted'
      : payload?.created === true ? 'created' : payload?.forced === true ? 'forced' : 'updated'
    const title = pushAction === 'deleted'
      ? `${repo}: ${actor} deleted ${ref.kind} ${ref.name}`
      : pushAction === 'created'
        ? `${repo}: ${actor} created ${ref.kind} ${ref.name}`
        : pushAction === 'forced'
          ? `${repo}: ${actor} force-pushed ${commitCountText(commits.length)} to ${ref.name}`
          : `${repo}: ${actor} pushed ${commitCountText(commits.length)} to ${ref.name}`
    return {
      type: `${eventName}.${pushAction}`,
      title,
      body: bodyLines(
        firstLine(payload?.head_commit?.message),
        labeled('Head', shortSha(payload?.after)),
      ),
      url: nonEmptyString(payload?.compare)
        ?? nonEmptyString(payload?.head_commit?.url)
        ?? repositoryUrl(payload),
      severity: pushAction === 'forced' || pushAction === 'deleted' ? 'warning' : 'info',
    }
  }
  if (eventName === 'deployment' && payload?.deployment) {
    const deployment = payload.deployment
    const environment = nonEmptyString(deployment.environment) ?? 'deployment'
    return {
      type,
      title: `${repo}: ${environment} deployment created`,
      body: bodyLines(
        labeled('Ref', deployment.ref),
        labeled('SHA', shortSha(deployment.sha)),
        nonEmptyString(deployment.description),
      ),
      url: nonEmptyString(payload?.workflow_run?.html_url) ?? repositoryDeploymentsUrl(payload),
      severity: 'info',
      shouldDeliver: false,
    }
  }
  if (eventName === 'deployment_status' && payload?.deployment_status) {
    const status = payload.deployment_status
    const state = nonEmptyString(status.state) ?? action
    const environment = nonEmptyString(status.environment)
      ?? nonEmptyString(payload?.deployment?.environment)
      ?? 'deployment'
    return {
      type: `${eventName}.${state}`,
      title: `${repo}: ${environment} deployment ${formatAction(state)}`,
      body: bodyLines(
        nonEmptyString(status.description),
        labeled('Ref', payload?.deployment?.ref),
        labeled('SHA', shortSha(payload?.deployment?.sha)),
      ),
      url: state === 'success'
        ? nonEmptyString(status.environment_url)
          ?? nonEmptyString(status.target_url)
          ?? repositoryDeploymentsUrl(payload)
        : nonEmptyString(status.log_url)
          ?? nonEmptyString(status.target_url)
          ?? nonEmptyString(payload?.workflow_run?.html_url)
          ?? repositoryDeploymentsUrl(payload),
      severity: DEPLOYMENT_STATE_SEVERITY[state] ?? 'warning',
      shouldDeliver: !NON_TERMINAL_DEPLOYMENT_STATES.has(state),
    }
  }
  if (eventName === 'page_build' && payload?.build) {
    const build = payload.build
    const state = nonEmptyString(build.status) ?? action
    return {
      type: `${eventName}.${state}`,
      title: `${repo}: Pages build ${formatAction(state)}`,
      body: bodyLines(
        nonEmptyString(build?.error?.message),
        labeled('Commit', shortSha(build.commit)),
      ),
      url: repositoryPath(payload, 'actions'),
      severity: state === 'errored' ? 'error' : 'info',
      shouldDeliver: !NON_TERMINAL_PAGE_BUILD_STATES.has(state),
    }
  }
  if (eventName === 'code_scanning_alert' && payload?.alert) {
    const alert = payload.alert
    const rule = alert.rule ?? {}
    const severityName = nonEmptyString(rule.security_severity_level) ?? nonEmptyString(rule.severity)
    const ruleName = nonEmptyString(rule.description)
      ?? nonEmptyString(rule.name)
      ?? nonEmptyString(rule.id)
      ?? `alert #${alert.number ?? '?'}`
    return {
      type,
      title: `[security] ${repo}: ${ruleName} (${formatAction(action)})`,
      body: bodyLines(
        labeled('Severity', severityName),
        labeled('Ref', payload?.ref ?? alert?.most_recent_instance?.ref),
        labeled('State', alert.state),
        labeled('Resolution', alert.dismissed_reason),
      ),
      url: nonEmptyString(alert.html_url),
      severity: INFORMATIONAL_CODE_SCANNING_ACTIONS.has(action)
        ? 'info'
        : severityFrom(severityName),
    }
  }
  if (eventName === 'dependabot_alert' && payload?.alert) {
    const alert = payload.alert
    const advisory = alert.security_advisory ?? {}
    const vulnerability = alert.security_vulnerability ?? {}
    const dependency = alert.dependency ?? {}
    const packageName = nonEmptyString(dependency?.package?.name)
      ?? nonEmptyString(vulnerability?.package?.name)
      ?? `dependency alert #${alert.number ?? '?'}`
    const patchedVersion = nonEmptyString(vulnerability?.first_patched_version?.identifier) ?? 'not available'
    return {
      type,
      title: `[security] ${repo}: ${packageName} ${formatAction(action)}`,
      body: bodyLines(
        nonEmptyString(advisory.summary),
        labeled('Severity', advisory.severity ?? vulnerability.severity),
        labeled('Vulnerable', vulnerability.vulnerable_version_range),
        labeled('Patched', patchedVersion),
        labeled('Manifest', dependency.manifest_path),
      ),
      url: nonEmptyString(alert.html_url) ?? nonEmptyString(advisory.html_url),
      severity: INFORMATIONAL_DEPENDABOT_ACTIONS.has(action)
        ? 'info'
        : severityFrom(advisory.severity ?? vulnerability.severity),
    }
  }
  if (eventName === 'secret_scanning_alert' && payload?.alert) {
    const alert = payload.alert
    const secretType = nonEmptyString(alert.secret_type_display_name)
      ?? nonEmptyString(alert.secret_type)
      ?? `secret alert #${alert.number ?? '?'}`
    const severity: Severity = INFORMATIONAL_SECRET_SCANNING_ACTIONS.has(action)
      ? 'info'
      : CRITICAL_SECRET_SCANNING_ACTIONS.has(action) ? 'critical' : 'warning'
    return {
      type,
      title: `[security] ${repo}: ${secretType} ${formatAction(action)}`,
      body: bodyLines(
        labeled('State', alert.state),
        labeled('Validity', alert.validity),
        labeled('Resolution', alert.resolution),
        typeof alert.push_protection_bypassed === 'boolean'
          ? `Push protection bypassed: ${alert.push_protection_bypassed ? 'yes' : 'no'}`
          : undefined,
      ),
      url: nonEmptyString(alert.html_url),
      severity,
    }
  }
  if (eventName === 'repository_advisory' && payload?.repository_advisory) {
    const advisory = payload.repository_advisory
    return {
      type,
      title: `[security] ${repo}: ${nonEmptyString(advisory.summary) ?? `advisory ${formatAction(action)}`}`,
      body: bodyLines(
        nonEmptyString(advisory.description),
        labeled('Severity', advisory.severity),
      ),
      url: nonEmptyString(advisory.html_url),
      severity: severityFrom(advisory.severity),
    }
  }
  if (eventName === 'security_advisory' && payload?.security_advisory) {
    const adv = payload.security_advisory
    return {
      type,
      title: `[security] ${adv.summary}`,
      body: typeof adv.description === 'string' ? adv.description : '',
      url: adv.html_url,
      severity: severityFrom(adv.severity),
    }
  }
  if (eventName === 'secret_scanning_alert_location' && payload?.alert) {
    const alert = payload.alert
    const location = payload.location ?? {}
    const details = location.details ?? {}
    const secretType = nonEmptyString(alert.secret_type_display_name)
      ?? nonEmptyString(alert.secret_type)
      ?? `secret alert #${alert.number ?? '?'}`
    return {
      type,
      title: `[security] ${repo}: new location for ${secretType}`,
      body: bodyLines(
        labeled('Location type', location.type),
        labeled('Path', details.path),
        labeled('State', alert.state),
      ),
      url: nonEmptyString(alert.html_url),
      severity: alert.state === 'resolved' ? 'info' : 'critical',
    }
  }
  if (eventName === 'secret_scanning_scan') {
    return {
      type,
      title: `${repo}: secret scanning ${formatAction(action)}`,
      body: bodyLines(
        labeled('Scan type', payload?.type),
        labeled('Source', payload?.source),
      ),
      severity: 'info',
      shouldDeliver: false,
    }
  }
  if (eventName === 'security_and_analysis') {
    const changed = payload?.changes && typeof payload.changes === 'object'
      ? Object.keys(payload.changes).sort()
      : []
    return {
      type,
      title: `[security] ${repo}: security settings changed`,
      body: changed.length > 0 ? `Changed: ${changed.join(', ')}` : '',
      url: repositoryPath(payload, 'settings/security_analysis'),
      severity: 'warning',
    }
  }
  if (eventName === 'star') {
    const actor = typeof payload?.sender?.login === 'string' ? payload.sender.login : 'Someone'
    const repoUrl = typeof payload?.repository?.html_url === 'string' ? payload.repository.html_url : undefined
    return {
      type,
      title: action === 'deleted'
        ? `${repo}: ${actor} removed a star`
        : `${repo}: ${actor} starred the repository`,
      body: '',
      url: repoUrl ? `${repoUrl}/stargazers` : undefined,
      severity: 'info',
    }
  }
  if (eventName === 'watch') {
    const actor = typeof payload?.sender?.login === 'string' ? payload.sender.login : 'Someone'
    const repoUrl = typeof payload?.repository?.html_url === 'string' ? payload.repository.html_url : undefined
    return {
      type,
      title: `${repo}: ${actor} started watching the repository`,
      body: '',
      url: repoUrl ? `${repoUrl}/watchers` : undefined,
      severity: 'info',
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
  if (eventName === 'workflow_job' && payload?.workflow_job) {
    const job = payload.workflow_job
    const state = nonEmptyString(job.conclusion) ?? nonEmptyString(job.status) ?? action
    const jobName = nonEmptyString(job.name) ?? 'workflow job'
    return {
      type,
      title: `${repo}: ${jobName} ${formatAction(state)}`,
      body: bodyLines(
        labeled('Workflow', job.workflow_name),
        labeled('Branch', job.head_branch),
        labeled('Runner', job.runner_name),
      ),
      url: nonEmptyString(job.html_url),
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
      shouldDeliver: eventName === GITHUB_PING_EVENT ? false : summary.shouldDeliver,
      raw: payload,
    }
  },
}

export default adapter
