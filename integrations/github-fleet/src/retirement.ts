import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { subscriptionKvKey } from '../../../src/lib/subscription'
import { discoverGitHubFleet, type GitHubFleetDiscoveryOptions } from './discovery'
import {
  beginGitHubFleetRepositoryRetirement,
  completeGitHubFleetRepositoryRetirement,
  githubFleetManifestProfiles,
  githubFleetManifestValues,
  parseGitHubFleetManifest,
  serializeGitHubFleetManifest,
  updateGitHubFleetRepositoryRetirement,
  type GitHubFleetManifest,
  type GitHubFleetManifestRepository,
  type GitHubFleetRetiredRepository,
} from './manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  buildGitHubFleetSubscription,
  githubFleetSubscriptionName,
  type GitHubFleetProfileName,
  type GitHubFleetProgress,
  type GitHubFleetSubscription,
} from './model'
import type { GitHubFleetOptions } from './fleet'
import {
  deleteGitHubRepositoryHook,
  listGitHubRepositoryHooks,
  matchingGitHubRepositoryHooks,
  type GitHubRepositoryHook,
} from '../../../scripts/providers/github/repository-hooks'
import { deleteRemoteKv, putRemoteKv, readRemoteKvSnapshot, type RemoteKvSnapshot } from '../../../scripts/kv'
import { disableSubscription, removeSubscription } from '../../../scripts/retirement-routes'
import { routeReferencesSecret } from '../../../scripts/retirement-manifest'
import {
  confirm,
  deleteWranglerSecretsBulk,
  getDevVar,
  listWranglerSecrets,
  readPrivateOptionalText,
  removeDevVar,
  writePrivateText,
  writeText,
} from '../../../scripts/setup'
import { computePlan, parseRoutes, type Routes, type Sub } from '../../../scripts/sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const ROUTE_PROPAGATION_TIMEOUT_MS = 90_000
const ROUTE_PROBE_INTERVAL_MS = 2_000
const ROUTE_PROPAGATION_GRACE_MS = 60_000

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GitHubFleetRetirementPlan {
  selected: string[]
  active: string[]
  retiring: string[]
  retired: string[]
  routesToDisable: string[]
  hooksToDelete: string[]
  routesToDelete: string[]
  secretsToDelete: string[]
  blockers: string[]
}

export interface GitHubFleetRetirementPrepareResult {
  repositories: string[]
  disabledSubscriptions: number
}

export interface GitHubFleetRetirementApplyResult {
  repositories: string[]
  deletedHooks: number
  deletedRoutes: number
  deletedSecrets: number
}

export interface GitHubFleetRetirementVerifyResult {
  repositories: string[]
  issues: string[]
}

export interface GitHubFleetRetirementDependencies {
  discover(root: string, options?: GitHubFleetDiscoveryOptions): ReturnType<typeof discoverGitHubFleet>
  readText(path: string): Promise<string>
  readPrivateText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  writePrivateText(path: string, text: string): Promise<void>
  readKv(progress?: GitHubFleetProgress): Promise<RemoteKvSnapshot>
  putKv(binding: string, key: string, value: string): Promise<void>
  deleteKv(binding: string, key: string): Promise<void>
  listHooks(repo: string): Promise<GitHubRepositoryHook[]>
  deleteHook(repo: string, id: number): Promise<void>
  listSecrets(): Promise<Set<string>>
  deleteSecrets(names: readonly string[]): Promise<Set<string>>
  fetch: Fetcher
  sleep(milliseconds: number): Promise<void>
  now(): number
  nowIso(): string
  routeTimeoutMs: number
  routeIntervalMs: number
  routeGraceMs: number
  confirm(question: string): Promise<boolean>
  log(line: string): void
}

const DEFAULT_DEPENDENCIES: GitHubFleetRetirementDependencies = {
  discover: discoverGitHubFleet,
  readText: (path) => readFile(path, 'utf8'),
  readPrivateText: readPrivateOptionalText,
  writeText,
  writePrivateText,
  readKv: (progress) => readRemoteKvSnapshot(undefined, progress),
  putKv: putRemoteKv,
  deleteKv: deleteRemoteKv,
  listHooks: listGitHubRepositoryHooks,
  deleteHook: deleteGitHubRepositoryHook,
  listSecrets: listWranglerSecrets,
  deleteSecrets: deleteWranglerSecretsBulk,
  fetch,
  sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  now: Date.now,
  nowIso: () => new Date().toISOString(),
  routeTimeoutMs: ROUTE_PROPAGATION_TIMEOUT_MS,
  routeIntervalMs: ROUTE_PROBE_INTERVAL_MS,
  routeGraceMs: ROUTE_PROPAGATION_GRACE_MS,
  confirm,
  log: console.log,
}

interface FleetRetirementFiles {
  routesText: string
  routes: Routes
  devVarsText: string
  manifest: GitHubFleetManifest
}

function paths(options: GitHubFleetOptions, projectRoot: string) {
  return {
    root: resolve(projectRoot, options.root),
    routes: resolve(projectRoot, ROUTES_FILE),
    devVars: resolve(projectRoot, DEV_VARS_FILE),
    manifest: resolve(projectRoot, options.manifest),
  }
}

function discoveryOptions(options: GitHubFleetOptions): GitHubFleetDiscoveryOptions {
  return {
    privateRepositories: new Set(options.includePrivate ? options.repositories : []),
    progress: options.progress,
  }
}

async function readFiles(
  options: GitHubFleetOptions,
  projectRoot: string,
  dependencies: GitHubFleetRetirementDependencies,
): Promise<FleetRetirementFiles> {
  const resolved = paths(options, projectRoot)
  const [routesText, devVarsText, manifestText] = await Promise.all([
    dependencies.readText(resolved.routes),
    dependencies.readPrivateText(resolved.devVars),
    dependencies.readPrivateText(resolved.manifest),
  ])
  return {
    routesText,
    routes: parseRoutes(routesText),
    devVarsText,
    manifest: parseGitHubFleetManifest(manifestText),
  }
}

function selectedRepositories(options: GitHubFleetOptions): string[] {
  if (!options.retire) throw new Error('GitHub fleet retirement requires --retire')
  if (options.repositories.length === 0) throw new Error('GitHub fleet retirement requires at least one --repo')
  return [...options.repositories].sort()
}

function repositoryProfiles(manifest: GitHubFleetManifest, repo: string): readonly GitHubFleetProfileName[] {
  const entry = manifest.repositories[repo] ?? manifest.retiredRepositories[repo]
  return entry ? githubFleetManifestProfiles(entry) : GITHUB_FLEET_PROFILE_NAMES
}

function profileRoutes(routes: Routes, repo: string): Partial<Record<GitHubFleetProfileName, Sub>> {
  const result: Partial<Record<GitHubFleetProfileName, Sub>> = {}
  for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
    const name = githubFleetSubscriptionName(repo, profile)
    const matches = routes.subs.filter((subscription) => subscription.name === name)
    if (matches.length > 1) throw new Error(`subscription is declared more than once: ${name}`)
    if (matches[0]) result[profile] = matches[0]
  }
  return result
}

async function desiredSubscriptions(
  repo: string,
  entry: GitHubFleetManifestRepository | GitHubFleetRetiredRepository,
): Promise<Record<GitHubFleetProfileName, GitHubFleetSubscription>> {
  const subscriptions = {} as Record<GitHubFleetProfileName, GitHubFleetSubscription>
  for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
    subscriptions[profile] = await buildGitHubFleetSubscription(repo, profile, githubFleetManifestValues(entry))
  }
  return subscriptions
}

function baseUrl(routes: Routes): string {
  if (!routes.baseUrl) throw new Error('routes.jsonc has no baseUrl')
  const parsed = new URL(routes.baseUrl)
  if (parsed.protocol !== 'https:' || parsed.origin !== routes.baseUrl.replace(/\/$/, '')) {
    throw new Error('routes.jsonc baseUrl must be an HTTPS origin')
  }
  return parsed.origin
}

function retirementUrl(routes: Routes, entry: GitHubFleetManifestRepository, profile: GitHubFleetProfileName): string {
  return `${baseUrl(routes)}/hook/github/${entry.slugs[profile]}`
}

async function waitForDisabledRoute(
  routes: Routes,
  repo: string,
  entry: GitHubFleetManifestRepository,
  profile: GitHubFleetProfileName,
  dependencies: GitHubFleetRetirementDependencies,
): Promise<void> {
  const deadline = dependencies.now() + dependencies.routeTimeoutMs
  const body = JSON.stringify({ repository: { full_name: repo } })
  do {
    let response: Response
    try {
      response = await dependencies.fetch(retirementUrl(routes, entry, profile), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': randomUUID(),
        },
        body,
      })
    } catch {
      throw new Error(`${githubFleetSubscriptionName(repo, profile)}: disabled route probe failed`)
    }
    if (response.status === 204) return
    if (response.status !== 404) {
      throw new Error(`${githubFleetSubscriptionName(repo, profile)}: disabled route probe returned status ${response.status}`)
    }
    if (dependencies.now() >= deadline) break
    await dependencies.sleep(dependencies.routeIntervalMs)
  } while (true)
  throw new Error(`${githubFleetSubscriptionName(repo, profile)}: timed out waiting for disabled route`)
}

function localRouteIssue(actual: Sub, desired: GitHubFleetSubscription): string | null {
  if (actual.slugHash !== desired.slugHash) return 'slug hash differs from the recovery manifest'
  if (actual.source !== desired.source) return 'source differs from the fleet profile'
  if (actual.auth?.secretEnv !== desired.auth.secretEnv) return 'HMAC reference differs from the recovery manifest'
  return null
}

export async function planGitHubFleetRetirement(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetRetirementPlan> {
  const selected = selectedRepositories(options)
  options.progress?.('Reading fleet retirement files')
  const files = await readFiles(options, projectRoot, dependencies)
  const resolved = paths(options, projectRoot)
  options.progress?.('Discovering repository checkouts')
  const discovery = await dependencies.discover(resolved.root, discoveryOptions(options))
  const discovered = new Set(discovery.repositories.map((repository) => repository.nameWithOwner))
  const blockers = [...discovery.blockers]
  const active: string[] = []
  const retiring: string[] = []
  const retired: string[] = []
  const routesToDisable: string[] = []
  const hooksToDelete: string[] = []
  const routesToDelete: string[] = []
  const secretsToDelete: string[] = []
  options.progress?.('Reading Worker secrets and remote routes')
  const [remote, secretNames] = await Promise.all([dependencies.readKv(options.progress), dependencies.listSecrets()])
  const selectedRouteNames = new Set(selected.flatMap((repo) => (
    repositoryProfiles(files.manifest, repo).map((profile) => githubFleetSubscriptionName(repo, profile))
  )))
  const remainingRoutes: Routes = {
    ...files.routes,
    subs: files.routes.subs.filter((subscription) => !selectedRouteNames.has(subscription.name)),
  }

  for (const [repoIndex, repo] of selected.entries()) {
    options.progress?.(`Inspecting retirement repository ${repoIndex + 1}/${selected.length}`)
    if (!discovered.has(repo)) blockers.push(`${repo}: selected retirement repository was not discovered`)
    const retiredEntry = files.manifest.retiredRepositories[repo]
    if (retiredEntry) {
      retired.push(repo)
      continue
    }
    const entry = files.manifest.repositories[repo]
    if (!entry) {
      blockers.push(`${repo}: manifest repository is missing`)
      continue
    }
    if (entry.state === 'retiring') retiring.push(repo)
    else active.push(repo)
    const desired = await desiredSubscriptions(repo, entry)
    const actual = profileRoutes(files.routes, repo)
    for (const profile of githubFleetManifestProfiles(entry)) {
      const name = githubFleetSubscriptionName(repo, profile)
      const route = actual[profile]
      if (!route) {
        if (entry.state !== 'retiring') blockers.push(`${name}: fleet route is missing`)
      } else {
        const issue = localRouteIssue(route, desired[profile])
        if (issue) blockers.push(`${name}: ${issue}`)
        if (route.enabled) routesToDisable.push(name)
        routesToDelete.push(name)
      }
      const remoteValue = remote.subs[subscriptionKvKey(desired[profile].slugHash)]
      if (remoteValue === undefined && entry.state !== 'retiring') {
        blockers.push(`${name}: production KV route is missing`)
      }
    }
    try {
      const hooks = await dependencies.listHooks(repo)
      for (const profile of githubFleetManifestProfiles(entry)) {
        const matches = await matchingGitHubRepositoryHooks(hooks, desired[profile].slugHash)
        if (matches.length > 1) blockers.push(`${githubFleetSubscriptionName(repo, profile)}: multiple matching GitHub hooks exist`)
        if (matches.length === 1) hooksToDelete.push(githubFleetSubscriptionName(repo, profile))
      }
    } catch (err) {
      blockers.push(`${repo}: webhook lookup failed (${err instanceof Error ? err.message : String(err)})`)
    }
    if (secretNames.has(entry.hmac.name) && !routeReferencesSecret(remainingRoutes, entry.hmac.name)) {
      secretsToDelete.push(entry.hmac.name)
    }
    const localValue = getDevVar(files.devVarsText, entry.hmac.name)
    if (localValue !== null && localValue !== entry.hmac.value) {
      blockers.push(`${repo}: .dev.vars HMAC disagrees with the recovery manifest`)
    }
  }

  return {
    selected,
    active,
    retiring,
    retired,
    routesToDisable: routesToDisable.sort(),
    hooksToDelete: hooksToDelete.sort(),
    routesToDelete: routesToDelete.sort(),
    secretsToDelete: [...new Set(secretsToDelete)].sort(),
    blockers,
  }
}

export function formatGitHubFleetRetirementPlan(plan: GitHubFleetRetirementPlan): string {
  const lines = [
    `Selected retirements: ${plan.selected.length}`,
    `Active repositories to stage: ${plan.active.length}`,
    `Retiring repositories: ${plan.retiring.length}`,
    `Already retired repositories: ${plan.retired.length}`,
    `Routes to disable: ${plan.routesToDisable.length}`,
    `Owned hooks to delete: ${plan.hooksToDelete.length}`,
    `Routes to delete: ${plan.routesToDelete.length}`,
    `Repository HMACs to delete: ${plan.secretsToDelete.length}`,
  ]
  for (const repo of plan.active) lines.push(`STAGE ${repo}`)
  for (const repo of plan.retiring) lines.push(`RETIRING ${repo}`)
  for (const repo of plan.retired) lines.push(`RETIRED ${repo}`)
  for (const blocker of plan.blockers) lines.push(`BLOCK ${blocker}`)
  return lines.join('\n')
}

export async function prepareGitHubFleetRetirement(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetRetirementPrepareResult> {
  const plan = await planGitHubFleetRetirement(options, dependencies, projectRoot)
  if (plan.blockers.length > 0) {
    throw new Error(`GitHub fleet retirement preparation blocked\n${plan.blockers.map((blocker) => `  - ${blocker}`).join('\n')}`)
  }
  const selected = selectedRepositories(options)
  const resolved = paths(options, projectRoot)
  const files = await readFiles(options, projectRoot, dependencies)
  let manifest = files.manifest
  for (const repo of selected) {
    if (manifest.retiredRepositories[repo]) continue
    manifest = beginGitHubFleetRepositoryRetirement(manifest, repo, dependencies.nowIso())
  }
  await dependencies.writePrivateText(resolved.manifest, serializeGitHubFleetManifest(manifest))

  let routesText = files.routesText
  let disabledSubscriptions = 0
  for (const repo of selected) {
    if (manifest.retiredRepositories[repo]) continue
    const entry = manifest.repositories[repo]
    if (!entry) continue
    for (const profile of githubFleetManifestProfiles(entry)) {
      const result = disableSubscription(routesText, githubFleetSubscriptionName(repo, profile))
      routesText = result.routesText
      if (result.changed) disabledSubscriptions += 1
    }
  }
  if (routesText !== files.routesText) await dependencies.writeText(resolved.routes, routesText)
  return { repositories: selected, disabledSubscriptions }
}

async function syncDisabledRoutes(
  routes: Routes,
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  dependencies: GitHubFleetRetirementDependencies,
  progress?: GitHubFleetProgress,
): Promise<void> {
  const keys = new Set<string>()
  const subscriptions = [...routes.subs]
  for (const repo of selected) {
    const entry = manifest.repositories[repo]
    if (!entry || entry.state !== 'retiring' || entry.retirement?.kvRemoved) continue
    const desired = await desiredSubscriptions(repo, entry)
    const existing = profileRoutes(routes, repo)
    for (const profile of githubFleetManifestProfiles(entry)) {
      const route = existing[profile]
      if (route?.enabled) throw new Error(`${route.name}: retirement route is still enabled locally`)
      const disabled = route ?? { ...desired[profile], enabled: false }
      if (!route) subscriptions.push(disabled)
      keys.add(subscriptionKvKey(disabled.slugHash))
    }
  }
  const desiredRoutes = { ...routes, subs: subscriptions }
  progress?.('Reading remote routes before retirement synchronization')
  const plan = computePlan(desiredRoutes, await dependencies.readKv(progress))
  const puts = plan.subPuts.filter((entry) => keys.has(entry.key))
  for (const [index, put] of puts.entries()) {
    progress?.(`Disabling remote route ${index + 1}/${puts.length}`)
    await dependencies.putKv('SUBS', put.key, put.value)
  }
  progress?.('Verifying disabled remote routes')
  const verification = computePlan(desiredRoutes, await dependencies.readKv(progress))
  if (verification.subPuts.some((entry) => keys.has(entry.key))) {
    throw new Error('production KV did not retain every disabled fleet route')
  }
}

async function saveManifest(
  path: string,
  manifest: GitHubFleetManifest,
  dependencies: GitHubFleetRetirementDependencies,
): Promise<void> {
  await dependencies.writePrivateText(path, serializeGitHubFleetManifest(manifest))
}

async function recordHookPlans(
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  dependencies: GitHubFleetRetirementDependencies,
  progress?: GitHubFleetProgress,
): Promise<GitHubFleetManifest> {
  let updated = manifest
  for (const [index, repo] of selected.entries()) {
    progress?.(`Recording repository hook retirement ${index + 1}/${selected.length}`)
    const entry = updated.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement) continue
    const desired = await desiredSubscriptions(repo, entry)
    const hooks = await dependencies.listHooks(repo)
    const plannedHooks = { ...entry.retirement.hooks }
    for (const profile of githubFleetManifestProfiles(entry)) {
      if (plannedHooks[profile]) continue
      const matches = await matchingGitHubRepositoryHooks(hooks, desired[profile].slugHash)
      if (matches.length > 1) throw new Error(`${githubFleetSubscriptionName(repo, profile)}: multiple matching GitHub hooks exist`)
      if (matches[0]) plannedHooks[profile] = { id: matches[0].id, deleted: false }
    }
    updated = updateGitHubFleetRepositoryRetirement(updated, repo, { hooks: plannedHooks })
  }
  return updated
}

async function deletePlannedHooks(
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  manifestPath: string,
  dependencies: GitHubFleetRetirementDependencies,
  progress?: GitHubFleetProgress,
): Promise<{ manifest: GitHubFleetManifest; count: number }> {
  let updated = manifest
  let count = 0
  const total = selected.reduce((sum, repo) => (
    sum + (updated.repositories[repo] ? githubFleetManifestProfiles(updated.repositories[repo]!).length : 0)
  ), 0)
  let index = 0
  for (const repo of selected) {
    let entry = updated.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement) continue
    const desired = await desiredSubscriptions(repo, entry)
    for (const profile of githubFleetManifestProfiles(entry)) {
      index += 1
      progress?.(`Deleting repository hook ${index}/${total}`)
      const retirement = entry.retirement
      if (!retirement) throw new Error(`${repo}: retirement phase state disappeared`)
      const planned = retirement.hooks[profile]
      if (!planned || planned.deleted) continue
      const hooks = await dependencies.listHooks(repo)
      const candidate = hooks.find((hook) => hook.id === planned.id)
      if (candidate) {
        const matches = await matchingGitHubRepositoryHooks(hooks, desired[profile].slugHash)
        if (!matches.some((match) => match.id === candidate.id)) {
          throw new Error(`${githubFleetSubscriptionName(repo, profile)}: planned GitHub hook no longer matches its archived route`)
        }
        await dependencies.deleteHook(repo, planned.id)
        count += 1
      }
      const nextHooks = {
        ...retirement.hooks,
        [profile]: { ...planned, deleted: true },
      }
      updated = updateGitHubFleetRepositoryRetirement(updated, repo, { hooks: nextHooks })
      await saveManifest(manifestPath, updated, dependencies)
      entry = updated.repositories[repo]!
    }
  }
  return { manifest: updated, count }
}

async function removeLocalRoutes(
  files: FleetRetirementFiles,
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  routesPath: string,
  manifestPath: string,
  dependencies: GitHubFleetRetirementDependencies,
): Promise<{ manifest: GitHubFleetManifest; routesText: string; count: number }> {
  let routesText = files.routesText
  let updated = manifest
  let count = 0
  for (const repo of selected) {
    const entry = updated.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement || entry.retirement.routesRemoved) continue
    for (const profile of githubFleetManifestProfiles(entry)) {
      const name = githubFleetSubscriptionName(repo, profile)
      if (parseRoutes(routesText).subs.some((subscription) => subscription.name === name)) {
        routesText = removeSubscription(routesText, name).routesText
        count += 1
      }
    }
    await dependencies.writeText(routesPath, routesText)
    updated = updateGitHubFleetRepositoryRetirement(updated, repo, { routesRemoved: true })
    await saveManifest(manifestPath, updated, dependencies)
  }
  return { manifest: updated, routesText, count }
}

async function deleteRemoteRoutes(
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  manifestPath: string,
  dependencies: GitHubFleetRetirementDependencies,
  progress?: GitHubFleetProgress,
): Promise<GitHubFleetManifest> {
  let updated = manifest
  const total = selected.reduce((sum, repo) => (
    sum + (updated.repositories[repo] ? githubFleetManifestProfiles(updated.repositories[repo]!).length : 0)
  ), 0)
  let index = 0
  for (const repo of selected) {
    const entry = updated.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement || entry.retirement.kvRemoved) continue
    const desired = await desiredSubscriptions(repo, entry)
    for (const profile of githubFleetManifestProfiles(entry)) {
      index += 1
      progress?.(`Deleting remote route ${index}/${total}`)
      await dependencies.deleteKv('SUBS', subscriptionKvKey(desired[profile].slugHash))
    }
    progress?.('Verifying deleted remote routes')
    const remote = await dependencies.readKv(progress)
    for (const profile of githubFleetManifestProfiles(entry)) {
      if (remote.subs[subscriptionKvKey(desired[profile].slugHash)] !== undefined) {
        throw new Error(`${githubFleetSubscriptionName(repo, profile)}: production KV route still exists after deletion`)
      }
    }
    updated = updateGitHubFleetRepositoryRetirement(updated, repo, { kvRemoved: true })
    await saveManifest(manifestPath, updated, dependencies)
  }
  return updated
}

async function deleteRepositorySecrets(
  manifest: GitHubFleetManifest,
  selected: readonly string[],
  routesText: string,
  devVarsText: string,
  devVarsPath: string,
  manifestPath: string,
  dependencies: GitHubFleetRetirementDependencies,
): Promise<{ manifest: GitHubFleetManifest; count: number }> {
  let updated = manifest
  let nextDevVars = devVarsText
  let count = 0
  for (const repo of selected) {
    const entry = updated.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement || entry.retirement.secretRemoved) continue
    if (routeReferencesSecret(parseRoutes(routesText), entry.hmac.name)) {
      dependencies.log(`Retained shared repository HMAC ${entry.hmac.name}`)
    } else {
      const remoteSecrets = await dependencies.listSecrets()
      if (remoteSecrets.has(entry.hmac.name)) {
        await dependencies.deleteSecrets([entry.hmac.name])
        count += 1
      }
      if (getDevVar(nextDevVars, entry.hmac.name) !== null) {
        nextDevVars = removeDevVar(nextDevVars, entry.hmac.name)
        await dependencies.writePrivateText(devVarsPath, nextDevVars)
      }
    }
    updated = updateGitHubFleetRepositoryRetirement(updated, repo, { secretRemoved: true })
    await saveManifest(manifestPath, updated, dependencies)
  }
  return { manifest: updated, count }
}

export async function applyGitHubFleetRetirement(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetRetirementApplyResult> {
  const plan = await planGitHubFleetRetirement(options, dependencies, projectRoot)
  if (plan.blockers.length > 0) {
    throw new Error(`GitHub fleet retirement apply blocked\n${plan.blockers.map((blocker) => `  - ${blocker}`).join('\n')}`)
  }
  const selected = selectedRepositories(options)
  if (!options.yes && !(await dependencies.confirm(`Apply these GitHub fleet retirements?\n${formatGitHubFleetRetirementPlan(plan)}`))) {
    throw new Error('GitHub fleet retirement apply cancelled')
  }
  const resolved = paths(options, projectRoot)
  const files = await readFiles(options, projectRoot, dependencies)
  const pending = selected.filter((repo) => !files.manifest.retiredRepositories[repo])
  for (const repo of pending) {
    const entry = files.manifest.repositories[repo]
    if (!entry || entry.state !== 'retiring' || !entry.retirement) {
      throw new Error(`${repo}: run the retirement prepare phase first`)
    }
  }
  if (pending.length === 0) return { repositories: selected, deletedHooks: 0, deletedRoutes: 0, deletedSecrets: 0 }

  await syncDisabledRoutes(files.routes, files.manifest, pending, dependencies, options.progress)
  const routeChecks = pending.flatMap((repo) => {
    const entry = files.manifest.repositories[repo]!
    return entry.retirement?.routesRemoved
      ? []
      : githubFleetManifestProfiles(entry).map((profile) => ({ repo, entry, profile }))
  })
  for (const [index, check] of routeChecks.entries()) {
    options.progress?.(`Probing disabled route ${index + 1}/${routeChecks.length}`)
    await waitForDisabledRoute(files.routes, check.repo, check.entry, check.profile, dependencies)
  }
  if (dependencies.routeGraceMs > 0) {
    options.progress?.(`Waiting ${dependencies.routeGraceMs / 1_000} seconds for route propagation`)
    await dependencies.sleep(dependencies.routeGraceMs)
    for (const [index, check] of routeChecks.entries()) {
      options.progress?.(`Rechecking disabled route ${index + 1}/${routeChecks.length}`)
      await waitForDisabledRoute(files.routes, check.repo, check.entry, check.profile, dependencies)
    }
  }

  let manifest = await recordHookPlans(files.manifest, pending, dependencies, options.progress)
  await saveManifest(resolved.manifest, manifest, dependencies)
  const hookDeletion = await deletePlannedHooks(manifest, pending, resolved.manifest, dependencies, options.progress)
  manifest = hookDeletion.manifest
  const routeRemoval = await removeLocalRoutes(
    files,
    manifest,
    pending,
    resolved.routes,
    resolved.manifest,
    dependencies,
  )
  manifest = routeRemoval.manifest
  manifest = await deleteRemoteRoutes(manifest, pending, resolved.manifest, dependencies, options.progress)
  const secretDeletion = await deleteRepositorySecrets(
    manifest,
    pending,
    routeRemoval.routesText,
    files.devVarsText,
    resolved.devVars,
    resolved.manifest,
    dependencies,
  )
  manifest = secretDeletion.manifest
  for (const repo of pending) {
    manifest = completeGitHubFleetRepositoryRetirement(manifest, repo, dependencies.nowIso())
    await saveManifest(resolved.manifest, manifest, dependencies)
  }
  return {
    repositories: selected,
    deletedHooks: hookDeletion.count,
    deletedRoutes: routeRemoval.count,
    deletedSecrets: secretDeletion.count,
  }
}

export async function verifyGitHubFleetRetirement(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetRetirementVerifyResult> {
  const selected = selectedRepositories(options)
  options.progress?.('Reading retired fleet files and remote state')
  const files = await readFiles(options, projectRoot, dependencies)
  const [remote, secrets] = await Promise.all([dependencies.readKv(options.progress), dependencies.listSecrets()])
  const issues: string[] = []
  for (const [index, repo] of selected.entries()) {
    options.progress?.(`Verifying retired repository ${index + 1}/${selected.length}`)
    const entry = files.manifest.retiredRepositories[repo]
    if (!entry) {
      issues.push(`${repo}: repository is not retired in the manifest`)
      continue
    }
    const desired = await desiredSubscriptions(repo, entry)
    const hooks = await dependencies.listHooks(repo)
    for (const profile of githubFleetManifestProfiles(entry)) {
      const name = githubFleetSubscriptionName(repo, profile)
      if (files.routes.subs.some((subscription) => subscription.name === name)) {
        issues.push(`${name}: local route still exists`)
      }
      if (remote.subs[subscriptionKvKey(desired[profile].slugHash)] !== undefined) {
        issues.push(`${name}: production KV route still exists`)
      }
      const matches = await matchingGitHubRepositoryHooks(hooks, desired[profile].slugHash)
      if (matches.length > 0) issues.push(`${name}: matching GitHub hook still exists`)
    }
    if (secrets.has(entry.hmac.name) && !routeReferencesSecret(files.routes, entry.hmac.name)) {
      issues.push(`${repo}: Wrangler HMAC still exists`)
    }
  }
  return { repositories: selected, issues }
}
