import { SUBSCRIPTION_SLUG_RE, hashSubscriptionSlug } from '../src/lib/subscription'
import { runProcess } from './setup'

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

type ProcessRunner = typeof runProcess

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
