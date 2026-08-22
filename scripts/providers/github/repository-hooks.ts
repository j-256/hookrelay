import { SUBSCRIPTION_SLUG_RE, hashSubscriptionSlug } from '../../../src/lib/subscription'
import type { GitHubEventSelection } from './event-profiles'
import { runProcess } from '../../setup'

const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const GITHUB_HOOK_PATH_RE = /^\/hook\/github\/([A-Za-z0-9_-]{22,})\/?$/

export interface GitHubRepositoryHook {
  id: number
  active: boolean
  events: string[]
  config: {
    url: string
    content_type: string
    insecure_ssl: string | number
  }
}

export interface GitHubRepositoryHookDelivery {
  id: string
  event: string
  statusCode: number | null
  deliveredAt: string | null
}

export interface GitHubHookPollingOptions {
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}

type ProcessRunner = typeof runProcess

const DEFAULT_PING_TIMEOUT_MS = 30_000
const DEFAULT_PING_INTERVAL_MS = 1_000

function gitHubApiArgs(method: string, path: string): string[] {
  return [
    'api',
    '--header',
    'Accept: application/vnd.github+json',
    '--header',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
    '--method',
    method,
    path,
  ]
}

export function validateGitHubRepo(repo: string): void {
  if (!GITHUB_REPOSITORY_RE.test(repo)) throw new Error(`invalid GitHub repository: ${repo}`)
}

function parseGitHubRepositoryHook(value: unknown): GitHubRepositoryHook {
  if (value === null || typeof value !== 'object') {
    throw new Error('GitHub returned invalid repository hook data')
  }
  const hook = value as Record<string, unknown>
  const config = hook.config
  const configRecord = config as Record<string, unknown>
  if (
    !Number.isSafeInteger(hook.id)
    || typeof hook.active !== 'boolean'
    || !Array.isArray(hook.events)
    || hook.events.some((event) => typeof event !== 'string')
    || config === null
    || typeof config !== 'object'
    || typeof configRecord.url !== 'string'
    || typeof configRecord.content_type !== 'string'
    || (typeof configRecord.insecure_ssl !== 'string' && typeof configRecord.insecure_ssl !== 'number')
  ) {
    throw new Error('GitHub returned invalid repository hook data')
  }
  return {
    id: hook.id as number,
    active: hook.active,
    events: [...hook.events] as string[],
    config: {
      url: configRecord.url,
      content_type: configRecord.content_type,
      insecure_ssl: configRecord.insecure_ssl,
    },
  }
}

export function parseGitHubRepositoryHookPages(text: string): GitHubRepositoryHook[] {
  let pages: unknown
  try {
    pages = JSON.parse(text)
  } catch {
    throw new Error('GitHub returned malformed repository hook data')
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('GitHub returned invalid repository hook data')
  }
  return pages.flatMap((page) => page.map(parseGitHubRepositoryHook))
}

export async function listGitHubRepositoryHooks(
  repo: string,
  runner: ProcessRunner = runProcess,
): Promise<GitHubRepositoryHook[]> {
  validateGitHubRepo(repo)
  const stdout = await runner(
    'gh',
    [
      'api',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      '--paginate',
      '--slurp',
      `repos/${repo}/hooks?per_page=100`,
    ],
    { captureStdout: true },
  )
  return parseGitHubRepositoryHookPages(stdout)
}

export function gitHubRepositoryHookSlug(hook: GitHubRepositoryHook): string | null {
  let url: URL
  try {
    url = new URL(hook.config.url)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.search || url.hash) return null
  const match = GITHUB_HOOK_PATH_RE.exec(url.pathname)
  if (!match || !SUBSCRIPTION_SLUG_RE.test(match[1]!)) return null
  return match[1]!
}

async function hookMatchesSlugHash(hook: GitHubRepositoryHook, slugHash: string): Promise<boolean> {
  const slug = gitHubRepositoryHookSlug(hook)
  return slug !== null && await hashSubscriptionSlug(slug) === slugHash
}

export async function matchingGitHubRepositoryHooks(
  hooks: GitHubRepositoryHook[],
  slugHash: string,
): Promise<GitHubRepositoryHook[]> {
  return (
    await Promise.all(hooks.map(async (hook) => ({ hook, matches: await hookMatchesSlugHash(hook, slugHash) })))
  ).filter(({ matches }) => matches).map(({ hook }) => hook)
}

export async function requireMatchingGitHubRepositoryHook(
  hooks: GitHubRepositoryHook[],
  slugHash: string,
  subscriptionName: string,
  repo: string,
): Promise<GitHubRepositoryHook> {
  const matches = await matchingGitHubRepositoryHooks(hooks, slugHash)
  if (matches.length === 0) {
    throw new Error(`matching GitHub webhook not found for subscription ${subscriptionName} in ${repo}`)
  }
  if (matches.length > 1) {
    throw new Error(`multiple GitHub webhooks match subscription ${subscriptionName} in ${repo}`)
  }
  return matches[0]!
}

export function sameGitHubEvents(current: readonly string[], desired: readonly string[]): boolean {
  if (current.length !== desired.length) return false
  const currentSet = new Set(current)
  return currentSet.size === current.length && desired.every((event) => currentSet.has(event))
}

export function githubHookPayload(
  webhookUrl: string,
  secret: string,
  selection: GitHubEventSelection,
): Record<string, unknown> | null {
  if (!secret) throw new Error('GitHub webhook secret is empty')
  if (!selection.events) return null
  return {
    name: 'web',
    active: true,
    events: [...selection.events],
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret,
      insecure_ssl: '0',
    },
  }
}

function desiredHookPayload(
  webhookUrl: string,
  secret: string,
  events: readonly string[],
): Record<string, unknown> {
  return {
    active: true,
    events: [...events],
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret,
      insecure_ssl: '0',
    },
  }
}

export function gitHubRepositoryHookMatches(
  hook: GitHubRepositoryHook,
  webhookUrl: string,
  events: readonly string[],
): boolean {
  return hook.active
    && hook.config.url === webhookUrl
    && hook.config.content_type === 'json'
    && String(hook.config.insecure_ssl) === '0'
    && sameGitHubEvents(hook.events, events)
}

export async function createGitHubRepositoryHook(
  repo: string,
  webhookUrl: string,
  secret: string,
  selection: GitHubEventSelection,
  runner: ProcessRunner = runProcess,
): Promise<number> {
  validateGitHubRepo(repo)
  const payload = githubHookPayload(webhookUrl, secret, selection)
  if (!payload) throw new Error('manual GitHub event selection cannot create a webhook')
  const hooks = await listGitHubRepositoryHooks(repo, runner)
  if (hooks.some((hook) => hook.config.url === webhookUrl)) {
    throw new Error(`GitHub webhook already exists for the requested subscription in ${repo}`)
  }
  const output = await runner('gh', [...gitHubApiArgs('POST', `repos/${repo}/hooks`), '--input', '-'], {
    input: JSON.stringify(payload),
    captureStdout: true,
  })
  const created = JSON.parse(output) as { id?: unknown }
  if (!Number.isSafeInteger(created.id) || (created.id as number) <= 0) {
    throw new Error('GitHub created the webhook without returning a valid id')
  }
  return created.id as number
}

export async function updateGitHubRepositoryHook(
  repo: string,
  hookId: number,
  webhookUrl: string,
  events: readonly string[],
  secret: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  validateGitHubRepo(repo)
  if (!Number.isSafeInteger(hookId) || hookId <= 0) throw new Error('invalid GitHub webhook id')
  if (!secret) throw new Error('GitHub webhook secret is empty')
  await runner(
    'gh',
    [...gitHubApiArgs('PATCH', `repos/${repo}/hooks/${hookId}`), '--silent', '--input', '-'],
    { input: JSON.stringify(desiredHookPayload(webhookUrl, secret, events)) },
  )
}

export async function updateGitHubRepositoryHookEvents(
  repo: string,
  hook: GitHubRepositoryHook,
  events: readonly string[],
  secret: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  validateGitHubRepo(repo)
  if (!Number.isSafeInteger(hook.id) || hook.id <= 0) throw new Error('invalid GitHub webhook id')
  if (!secret) throw new Error('GitHub webhook secret is empty')
  // GitHub clears an existing secret unless the general webhook update supplies it again
  await runner(
    'gh',
    [
      'api',
      '--header',
      'Accept: application/vnd.github+json',
      '--header',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`,
      '--method',
      'PATCH',
      '--silent',
      `repos/${repo}/hooks/${hook.id}`,
      '--input',
      '-',
    ],
    {
      input: JSON.stringify({
        active: hook.active,
        events,
        config: {
          ...hook.config,
          secret,
        },
      }),
    },
  )
}

export async function deleteGitHubRepositoryHook(
  repo: string,
  hookId: number,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  validateGitHubRepo(repo)
  if (!Number.isSafeInteger(hookId) || hookId <= 0) throw new Error('invalid GitHub webhook id')
  await runner('gh', [...gitHubApiArgs('DELETE', `repos/${repo}/hooks/${hookId}`), '--silent'])
}

function parseGitHubRepositoryHookDelivery(value: unknown): GitHubRepositoryHookDelivery {
  if (value === null || typeof value !== 'object') throw new Error('GitHub returned invalid hook delivery data')
  const record = value as Record<string, unknown>
  if (
    typeof record.guid !== 'string'
    || record.guid.length === 0
    || typeof record.event !== 'string'
    || (record.status_code !== null && typeof record.status_code !== 'number')
    || (record.delivered_at !== null && typeof record.delivered_at !== 'string')
  ) {
    throw new Error('GitHub returned invalid hook delivery data')
  }
  return {
    id: record.guid,
    event: record.event,
    statusCode: record.status_code as number | null,
    deliveredAt: record.delivered_at as string | null,
  }
}

export function parseGitHubRepositoryHookDeliveryPages(text: string): GitHubRepositoryHookDelivery[] {
  let pages: unknown
  try {
    pages = JSON.parse(text)
  } catch {
    throw new Error('GitHub returned malformed hook delivery data')
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('GitHub returned invalid hook delivery data')
  }
  return pages.flatMap((page) => page.map(parseGitHubRepositoryHookDelivery))
}

export async function listGitHubRepositoryHookDeliveries(
  repo: string,
  hookId: number,
  runner: ProcessRunner = runProcess,
): Promise<GitHubRepositoryHookDelivery[]> {
  validateGitHubRepo(repo)
  if (!Number.isSafeInteger(hookId) || hookId <= 0) throw new Error('invalid GitHub webhook id')
  const output = await runner('gh', [
    ...gitHubApiArgs('GET', `repos/${repo}/hooks/${hookId}/deliveries?per_page=100`),
    '--paginate',
    '--slurp',
  ], { captureStdout: true })
  return parseGitHubRepositoryHookDeliveryPages(output)
}

export async function triggerGitHubRepositoryHookPing(
  repo: string,
  hookId: number,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  validateGitHubRepo(repo)
  if (!Number.isSafeInteger(hookId) || hookId <= 0) throw new Error('invalid GitHub webhook id')
  await runner('gh', [...gitHubApiArgs('POST', `repos/${repo}/hooks/${hookId}/pings`), '--silent'])
}

export async function pingAndVerifyGitHubRepositoryHook(
  repo: string,
  hookId: number,
  runner: ProcessRunner = runProcess,
  polling: GitHubHookPollingOptions = {},
): Promise<GitHubRepositoryHookDelivery> {
  const timeoutMs = polling.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS
  const intervalMs = polling.intervalMs ?? DEFAULT_PING_INTERVAL_MS
  const now = polling.now ?? Date.now
  const sleep = polling.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  if (timeoutMs <= 0 || intervalMs <= 0) throw new Error('GitHub hook polling intervals must be positive')

  const existingIds = new Set((await listGitHubRepositoryHookDeliveries(repo, hookId, runner)).map(({ id }) => id))
  await triggerGitHubRepositoryHookPing(repo, hookId, runner)
  const deadline = now() + timeoutMs
  do {
    const delivery = (await listGitHubRepositoryHookDeliveries(repo, hookId, runner))
      .find((candidate) => !existingIds.has(candidate.id) && candidate.event === 'ping')
    if (delivery?.statusCode !== null && delivery !== undefined) {
      if (delivery.statusCode < 200 || delivery.statusCode >= 300) {
        throw new Error(`GitHub webhook ${hookId} in ${repo} returned status ${delivery.statusCode} for ping`)
      }
      return delivery
    }
    if (now() >= deadline) break
    await sleep(intervalMs)
  } while (true)
  throw new Error(`timed out waiting for GitHub webhook ${hookId} ping delivery in ${repo}`)
}
