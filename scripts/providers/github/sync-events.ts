import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { subscriptionKvKey } from '../../../src/lib/subscription'
import { getDevVar, readPrivateOptionalText, runSync } from '../../setup'
import { parseRoutes, type ProviderSyncScope } from '../../sync'
import { parseGitHubEventSelection } from './event-profiles'
import {
  listGitHubRepositoryHooks,
  requireMatchingGitHubRepositoryHook,
  sameGitHubEvents,
  updateGitHubRepositoryHookEvents,
  validateGitHubRepo,
  type GitHubRepositoryHook,
} from './repository-hooks'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const GITHUB_AUTH_SCHEME = 'github-sha256'

type ListHooks = typeof listGitHubRepositoryHooks
type UpdateHook = typeof updateGitHubRepositoryHookEvents

export interface GitHubEventSyncChange {
  name: string
  repo: string
  slugHash: string
  before: GitHubRepositoryHook
  events: readonly string[]
  secret: string
}

export interface GitHubEventSyncPlan {
  checked: number
  providerScope: ProviderSyncScope
  changes: GitHubEventSyncChange[]
}

export interface GitHubEventSyncDependencies {
  listHooks: ListHooks
  updateHook: UpdateHook
  syncProvider: (apply: boolean, scope: ProviderSyncScope) => Promise<void>
  progress?: (message: string) => void
}

export function githubEventSyncUsage(): string {
  return [
    'usage: pnpm github:sync [-y]',
    '',
    'Preview or apply saved event profiles for existing GitHub subscriptions in routes.jsonc.',
    'The command reads .dev.vars for sender secrets and requires gh access to repository hooks.',
    'Provider filtering is synchronized before GitHub webhook events are changed.',
    '',
    'options:',
    '  -y, --yes   apply provider filtering and changed GitHub webhook events',
    '  -h, --help  show this help',
    '',
    'Exit status: 0 success, 1 runtime or provider failure, 2 invalid arguments.',
  ].join('\n')
}

export function parseGitHubEventSyncArgs(argv: readonly string[]): { yes: boolean; help?: boolean } {
  let yes = false
  let help = false
  let endOfOptions = false
  for (const arg of argv) {
    if (arg === '--' && !endOfOptions) {
      endOfOptions = true
      continue
    }
    if (endOfOptions) throw new Error(`unexpected argument: ${arg}`)
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (/^-[yh]{2,}$/.test(arg)) {
      if (arg.includes('y')) yes = true
      if (arg.includes('h')) help = true
    } else throw new Error(`unknown option: ${arg}`)
  }
  return help ? { yes, help } : { yes }
}

function sameHookConfig(current: GitHubRepositoryHook, before: GitHubRepositoryHook): boolean {
  return current.id === before.id
    && current.active === before.active
    && current.config.url === before.config.url
    && current.config.content_type === before.config.content_type
    && String(current.config.insecure_ssl) === String(before.config.insecure_ssl)
}

function copyHook(hook: GitHubRepositoryHook): GitHubRepositoryHook {
  return { ...hook, events: [...hook.events], config: { ...hook.config } }
}

export async function planGitHubEventSync(
  routesText: string,
  devVarsText: string,
  listHooks: ListHooks = listGitHubRepositoryHooks,
  progress?: (message: string) => void,
): Promise<GitHubEventSyncPlan> {
  const routes = parseRoutes(routesText)
  const subscriptions = routes.subs.filter((sub) => sub.source === 'github')
  const names = new Set<string>()
  const hashes = new Set<string>()
  const repoNames = new Set<string>()
  for (const sub of subscriptions) {
    if (names.has(sub.name)) throw new Error(`GitHub subscription is declared more than once: ${sub.name}`)
    names.add(sub.name)
    if (hashes.has(sub.slugHash)) throw new Error(`GitHub subscription slug hash is reused: ${sub.name}`)
    hashes.add(sub.slugHash)
    if (!sub.setup?.github) throw new Error(`GitHub subscription has no setup.github metadata: ${sub.name}`)
    validateGitHubRepo(sub.setup.github.repo)
    repoNames.add(sub.setup.github.repo)
  }

  const hooksByRepo = new Map<string, GitHubRepositoryHook[]>()
  const repositories = [...repoNames].sort()
  for (const [index, repo] of repositories.entries()) {
    progress?.(`Reading GitHub repository hooks ${index + 1}/${repositories.length}`)
    hooksByRepo.set(repo, await listHooks(repo))
  }

  const changes: GitHubEventSyncChange[] = []
  for (const sub of subscriptions) {
    const github = sub.setup!.github!
    const selection = parseGitHubEventSelection(github.eventProfiles.join(','))
    if (selection.kind === 'manual') continue
    if (sub.auth?.scheme !== GITHUB_AUTH_SCHEME || !sub.auth.secretEnv) {
      throw new Error(`subscription has no ${GITHUB_AUTH_SCHEME} sender secret: ${sub.name}`)
    }
    const hook = await requireMatchingGitHubRepositoryHook(
      hooksByRepo.get(github.repo)!, sub.slugHash, sub.name, github.repo,
    )
    if (sameGitHubEvents(hook.events, selection.events!)) continue
    const secret = getDevVar(devVarsText, sub.auth.secretEnv)
    if (secret === null) throw new Error(`${sub.auth.secretEnv} is missing from .dev.vars for ${sub.name}`)
    changes.push({
      name: sub.name,
      repo: github.repo,
      slugHash: sub.slugHash,
      before: copyHook(hook),
      events: [...selection.events!],
      secret,
    })
  }

  return {
    checked: subscriptions.length,
    providerScope: {
      puts: subscriptions.map((sub) => ({
        namespace: 'SUBS' as const,
        key: subscriptionKvKey(sub.slugHash),
        policyFields: ['filter' as const],
      })),
    },
    changes,
  }
}

export function formatGitHubEventSyncPlan(plan: GitHubEventSyncPlan): string {
  const lines = [
    `GitHub subscriptions checked: ${plan.checked}`,
    `GitHub webhook event updates: ${plan.changes.length}`,
  ]
  for (const change of plan.changes) {
    lines.push(`UPDATE ${change.name}: ${change.before.events.join(',')} -> ${change.events.join(',')}`)
  }
  return lines.join('\n')
}

export async function applyGitHubEventSync(
  plan: GitHubEventSyncPlan,
  dependencies: GitHubEventSyncDependencies,
): Promise<{ updated: number }> {
  const affectedRepos = [...new Set(plan.changes.map((change) => change.repo))].sort()
  const beforeByRepo = new Map<string, GitHubRepositoryHook[]>()
  for (const repo of affectedRepos) beforeByRepo.set(repo, await dependencies.listHooks(repo))
  for (const change of plan.changes) {
    const current = await requireMatchingGitHubRepositoryHook(
      beforeByRepo.get(change.repo)!, change.slugHash, change.name, change.repo,
    )
    if (!sameHookConfig(current, change.before) || !sameGitHubEvents(current.events, change.before.events)) {
      throw new Error(`${change.name}: GitHub webhook changed since preview`)
    }
  }

  if (plan.providerScope.puts?.length) await dependencies.syncProvider(true, plan.providerScope)

  let updated = 0
  for (const change of plan.changes) {
    try {
      await dependencies.updateHook(change.repo, change.before, change.events, change.secret)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`${change.name}: GitHub update failed after ${updated}/${plan.changes.length} hooks (${reason})`)
    }
    updated += 1
    dependencies.progress?.(`Updated GitHub webhook events ${updated}/${plan.changes.length}: ${change.name}`)
  }

  const afterByRepo = new Map<string, GitHubRepositoryHook[]>()
  for (const repo of affectedRepos) afterByRepo.set(repo, await dependencies.listHooks(repo))
  for (const change of plan.changes) {
    const current = await requireMatchingGitHubRepositoryHook(
      afterByRepo.get(change.repo)!, change.slugHash, change.name, change.repo,
    )
    if (!sameHookConfig(current, change.before) || !sameGitHubEvents(current.events, change.events)) {
      throw new Error(`${change.name}: GitHub webhook did not match after ${updated} updates; rerun pnpm github:sync`)
    }
  }
  return { updated }
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseGitHubEventSyncArgs>
  try {
    options = parseGitHubEventSyncArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    console.error(githubEventSyncUsage())
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(githubEventSyncUsage())
    return
  }

  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  const [routesText, devVarsText] = await Promise.all([
    readFile(routesPath, 'utf8'),
    readPrivateOptionalText(devVarsPath),
  ])
  const plan = await planGitHubEventSync(routesText, devVarsText, listGitHubRepositoryHooks, (message) => {
    console.error(`PROGRESS ${message}`)
  })
  console.log(formatGitHubEventSyncPlan(plan))
  if (plan.providerScope.puts?.length) await runSync(false, undefined, plan.providerScope)
  if (!options.yes) {
    console.log('Preview only; run pnpm github:sync -y to apply')
    return
  }
  const [currentRoutes, currentDevVars] = await Promise.all([
    readFile(routesPath, 'utf8'),
    readPrivateOptionalText(devVarsPath),
  ])
  if (currentRoutes !== routesText || currentDevVars !== devVarsText) {
    throw new Error('Local configuration changed during preview; rerun pnpm github:sync')
  }
  const result = await applyGitHubEventSync(plan, {
    listHooks: listGitHubRepositoryHooks,
    updateHook: updateGitHubRepositoryHookEvents,
    syncProvider: (apply, scope) => runSync(apply, undefined, scope),
    progress: (message) => console.error(`PROGRESS ${message}`),
  })
  console.log(`Verified GitHub webhook event updates: ${result.updated}`)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
