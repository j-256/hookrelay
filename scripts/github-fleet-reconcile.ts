import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import { hmacSha256Hex } from '../src/lib/hmac'
import { subscriptionKvKey } from '../src/lib/subscription'
import {
  formatGitHubFleetPlan,
  planGitHubFleet,
  type GitHubFleetDependencies,
  type GitHubFleetOptions,
  type GitHubFleetPlan,
} from './github-fleet'
import {
  parseGitHubFleetManifest,
  serializeGitHubFleetManifest,
  type GitHubFleetManifest,
  type GitHubFleetManifestRepository,
} from './github-fleet-manifest'
import {
  GITHUB_FLEET_AUTH_SCHEME,
  GITHUB_FLEET_PROFILE_NAMES,
  GITHUB_FLEET_PROFILES,
  githubFleetSubscriptionName,
  type GitHubFleetProfileName,
} from './github-fleet-model'
import { parseGitHubEventSelection } from './github-events'
import {
  createGitHubRepositoryHook,
  gitHubRepositoryHookMatches,
  listGitHubRepositoryHooks,
  matchingGitHubRepositoryHooks,
  pingAndVerifyGitHubRepositoryHook,
  updateGitHubRepositoryHook,
  type GitHubRepositoryHook,
} from './github-repository'
import { putRemoteKv, readRemoteKvSnapshot, type RemoteKvSnapshot } from './kv'
import {
  confirm,
  deleteWranglerSecretsBulk,
  getDevVar,
  listWranglerSecrets,
  putWranglerSecretsBulk,
  readPrivateOptionalText,
  removeDevVar,
  writePrivateText,
  writeText,
  type SecretValue,
} from './setup'
import { computePlan, parseRoutes, type Routes, type Sub } from './sync'

export const ROUTE_PROPAGATION_TIMEOUT_MS = 90_000
export const ROUTE_PROBE_INTERVAL_MS = 2_000
export const ROUTE_PROPAGATION_GRACE_MS = 60_000
export const GITHUB_MUTATION_ATTEMPTS = 3
export const GITHUB_MUTATION_RETRY_MS = 2_000

const SITE_REPOSITORY = 'example-owner/example-repo'
const SITE_RETIRING_SECRET_NAMES = Object.freeze([
  'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS',
  'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_ALERTS',
])
const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GitHubFleetReconcileDependencies {
  planDependencies?: GitHubFleetDependencies
  fetch?: Fetcher
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  confirm?: (question: string) => Promise<boolean>
  listHooks?: typeof listGitHubRepositoryHooks
  createHook?: typeof createGitHubRepositoryHook
  updateHook?: typeof updateGitHubRepositoryHook
  pingHook?: typeof pingAndVerifyGitHubRepositoryHook
  listSecrets?: typeof listWranglerSecrets
  putSecrets?: (secrets: readonly SecretValue[]) => Promise<Set<string>>
  deleteSecrets?: (names: readonly string[]) => Promise<Set<string>>
  readKv?: () => Promise<RemoteKvSnapshot>
  putKv?: (binding: string, key: string, value: string) => Promise<void>
  routeTimeoutMs?: number
  routeIntervalMs?: number
  routeGraceMs?: number
  mutationAttempts?: number
  mutationRetryMs?: number
}

export interface GitHubFleetApplyResult {
  selected: string[]
  installedSecrets: number
  reconciledHooks: number
  siteConsolidated: boolean
}

export interface GitHubFleetVerifyResult {
  repositories: string[]
  verifiedHooks: number
  issues: string[]
}

interface ResolvedDependencies {
  planDependencies: GitHubFleetDependencies | undefined
  fetch: Fetcher
  sleep: (milliseconds: number) => Promise<void>
  now: () => number
  confirm: (question: string) => Promise<boolean>
  listHooks: typeof listGitHubRepositoryHooks
  createHook: typeof createGitHubRepositoryHook
  updateHook: typeof updateGitHubRepositoryHook
  pingHook: typeof pingAndVerifyGitHubRepositoryHook
  listSecrets: typeof listWranglerSecrets
  putSecrets: (secrets: readonly SecretValue[]) => Promise<Set<string>>
  deleteSecrets: (names: readonly string[]) => Promise<Set<string>>
  readKv: () => Promise<RemoteKvSnapshot>
  putKv: (binding: string, key: string, value: string) => Promise<void>
  routeTimeoutMs: number
  routeIntervalMs: number
  routeGraceMs: number
  mutationAttempts: number
  mutationRetryMs: number
}

interface FleetFiles {
  routesPath: string
  devVarsPath: string
  manifestPath: string
  routesText: string
  devVarsText: string
  manifestText: string
  routes: Routes
  manifest: GitHubFleetManifest
}

export interface DesiredHook {
  repo: string
  profile: GitHubFleetProfileName
  subscriptionName: string
  slugHash: string
  url: string
  secret: string
  events: readonly string[]
}

function resolvedDependencies(input: GitHubFleetReconcileDependencies): ResolvedDependencies {
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)))
  return {
    planDependencies: input.planDependencies,
    fetch: input.fetch ?? fetch,
    sleep,
    now: input.now ?? Date.now,
    confirm: input.confirm ?? confirm,
    listHooks: input.listHooks ?? listGitHubRepositoryHooks,
    createHook: input.createHook ?? createGitHubRepositoryHook,
    updateHook: input.updateHook ?? updateGitHubRepositoryHook,
    pingHook: input.pingHook ?? pingAndVerifyGitHubRepositoryHook,
    listSecrets: input.listSecrets ?? listWranglerSecrets,
    putSecrets: input.putSecrets ?? ((secrets) => putWranglerSecretsBulk(secrets)),
    deleteSecrets: input.deleteSecrets ?? ((names) => deleteWranglerSecretsBulk(names)),
    readKv: input.readKv ?? readRemoteKvSnapshot,
    putKv: input.putKv ?? putRemoteKv,
    routeTimeoutMs: input.routeTimeoutMs ?? ROUTE_PROPAGATION_TIMEOUT_MS,
    routeIntervalMs: input.routeIntervalMs ?? ROUTE_PROBE_INTERVAL_MS,
    routeGraceMs: input.routeGraceMs ?? ROUTE_PROPAGATION_GRACE_MS,
    mutationAttempts: input.mutationAttempts ?? GITHUB_MUTATION_ATTEMPTS,
    mutationRetryMs: input.mutationRetryMs ?? GITHUB_MUTATION_RETRY_MS,
  }
}

function projectPath(projectRoot: string, value: string): string {
  return resolve(projectRoot, value)
}

async function readFleetFiles(
  options: GitHubFleetOptions,
  projectRoot: string,
  dependencies: ResolvedDependencies,
): Promise<FleetFiles> {
  const routesPath = projectPath(projectRoot, ROUTES_FILE)
  const devVarsPath = projectPath(projectRoot, DEV_VARS_FILE)
  const manifestPath = projectPath(projectRoot, options.manifest)
  const fileSystem = dependencies.planDependencies?.fileSystem
  const [routesText, devVarsText, manifestText] = await Promise.all([
    readFile(routesPath, 'utf8'),
    readPrivateOptionalText(devVarsPath, fileSystem),
    readPrivateOptionalText(manifestPath, fileSystem),
  ])
  return {
    routesPath,
    devVarsPath,
    manifestPath,
    routesText,
    devVarsText,
    manifestText,
    routes: parseRoutes(routesText),
    manifest: parseGitHubFleetManifest(manifestText),
  }
}

function baseUrl(routes: Routes): string {
  if (!routes.baseUrl) throw new Error('routes.jsonc has no baseUrl')
  const parsed = new URL(routes.baseUrl)
  if (parsed.protocol !== 'https:' || parsed.origin !== routes.baseUrl.replace(/\/$/, '')) {
    throw new Error('routes.jsonc baseUrl must be an HTTPS origin')
  }
  return parsed.origin
}

function namedSubscription(routes: Routes, name: string): Sub {
  const matches = routes.subs.filter((sub) => sub.name === name)
  if (matches.length !== 1) throw new Error(`expected one subscription named ${name}`)
  return matches[0]!
}

function desiredHook(
  routes: Routes,
  manifest: GitHubFleetManifest,
  repo: string,
  profile: GitHubFleetProfileName,
): DesiredHook {
  const entry = manifest.repositories[repo]
  if (!entry) throw new Error(`${repo}: manifest entry is missing`)
  const subscriptionName = githubFleetSubscriptionName(repo, profile)
  const sub = namedSubscription(routes, subscriptionName)
  const selection = parseGitHubEventSelection(GITHUB_FLEET_PROFILES[profile].eventProfiles.join(','))
  if (!selection.events) throw new Error(`${subscriptionName}: event selection is not automatic`)
  return {
    repo,
    profile,
    subscriptionName,
    slugHash: sub.slugHash,
    url: `${baseUrl(routes)}/hook/github/${entry.slugs[profile]}`,
    secret: entry.hmac.value,
    events: selection.events,
  }
}

function updateSubscriptionAuth(
  routesText: string,
  subscriptionName: string,
  secretEnv: string,
  alternateSecretEnvs?: string[],
): string {
  const routes = parseRoutes(routesText)
  const index = routes.subs.findIndex((sub) => sub.name === subscriptionName)
  if (index < 0) throw new Error(`subscription not found: ${subscriptionName}`)
  const auth = {
    scheme: GITHUB_FLEET_AUTH_SCHEME,
    secretEnv,
    ...(alternateSecretEnvs && alternateSecretEnvs.length > 0 ? { alternateSecretEnvs } : {}),
  }
  const updated = applyEdits(routesText, modify(routesText, ['subs', index, 'auth'], auth, {
    formattingOptions: FORMATTING_OPTIONS,
  }))
  parseRoutes(updated)
  return updated.endsWith('\n') ? updated : `${updated}\n`
}

function targetSubscriptionKeys(routes: Routes, names: readonly string[]): Set<string> {
  return new Set(names.map((name) => subscriptionKvKey(namedSubscription(routes, name).slugHash)))
}

async function syncSubscriptionRoutes(
  routes: Routes,
  names: readonly string[],
  dependencies: ResolvedDependencies,
  includeSinks = false,
): Promise<void> {
  const keys = targetSubscriptionKeys(routes, names)
  const current = await dependencies.readKv()
  const plan = computePlan(routes, current)
  for (const put of plan.subPuts.filter((entry) => keys.has(entry.key))) {
    await dependencies.putKv('SUBS', put.key, put.value)
  }
  if (includeSinks) {
    for (const put of plan.sinkPuts) await dependencies.putKv('SINKS', put.key, put.value)
  }
  const verified = computePlan(routes, await dependencies.readKv())
  const remaining = verified.subPuts.filter((entry) => keys.has(entry.key))
  if (remaining.length > 0) throw new Error(`central KV did not retain ${remaining.length} subscription updates`)
  if (includeSinks && verified.sinkPuts.length > 0) {
    throw new Error(`central KV did not retain ${verified.sinkPuts.length} sink updates`)
  }
}

function pingPayload(repo: string): string {
  return JSON.stringify({
    zen: 'Keep it logically awesome.',
    hook_id: 0,
    repository: { full_name: repo },
  })
}

async function probeRouteStatus(
  hook: DesiredHook,
  dependencies: ResolvedDependencies,
  secret?: string,
): Promise<number> {
  const body = pingPayload(hook.repo)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': 'ping',
    'x-github-delivery': randomUUID(),
  }
  if (secret !== undefined) {
    const signature = await hmacSha256Hex(secret, new TextEncoder().encode(body))
    headers['x-hub-signature-256'] = `sha256=${signature}`
  }
  const response = await dependencies.fetch(hook.url, { method: 'POST', body, headers })
  return response.status
}

async function waitForRouteStatus(
  hook: DesiredHook,
  expectedStatus: number,
  dependencies: ResolvedDependencies,
  secret?: string,
): Promise<void> {
  const deadline = dependencies.now() + dependencies.routeTimeoutMs
  do {
    const status = await probeRouteStatus(hook, dependencies, secret)
    if (status === expectedStatus) return
    const transitional = status === 404
      || (secret !== undefined && (status === 200 || status === 401))
    if (!transitional) {
      throw new Error(`${hook.subscriptionName}: route probe returned unexpected status ${status}`)
    }
    if (dependencies.now() >= deadline) break
    await dependencies.sleep(dependencies.routeIntervalMs)
  } while (true)
  throw new Error(`${hook.subscriptionName}: timed out waiting for route status ${expectedStatus}`)
}

export async function waitForUnsignedGitHubRoute(
  hook: DesiredHook,
  dependenciesInput: GitHubFleetReconcileDependencies = {},
): Promise<void> {
  await waitForRouteStatus(hook, 401, resolvedDependencies(dependenciesInput))
}

async function writeRoutesAndSync(
  files: FleetFiles,
  routesText: string,
  subscriptionNames: readonly string[],
  dependencies: ResolvedDependencies,
): Promise<FleetFiles> {
  await writeText(files.routesPath, routesText, dependencies.planDependencies?.fileSystem)
  const routes = parseRoutes(routesText)
  await syncSubscriptionRoutes(routes, subscriptionNames, dependencies)
  return { ...files, routesText, routes }
}

async function retryMutation<T>(
  action: () => Promise<T>,
  dependencies: ResolvedDependencies,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= dependencies.mutationAttempts; attempt += 1) {
    try {
      return await action()
    } catch (err) {
      lastError = err
      if (attempt < dependencies.mutationAttempts) await dependencies.sleep(dependencies.mutationRetryMs * attempt)
    }
  }
  throw lastError
}

async function requireOneManagedHook(hook: DesiredHook, dependencies: ResolvedDependencies): Promise<GitHubRepositoryHook> {
  const matches = await matchingGitHubRepositoryHooks(await dependencies.listHooks(hook.repo), hook.slugHash)
  if (matches.length === 0) throw new Error(`${hook.subscriptionName}: matching GitHub hook is missing`)
  if (matches.length > 1) throw new Error(`${hook.subscriptionName}: multiple matching GitHub hooks exist`)
  return matches[0]!
}

async function patchAndPingManagedHook(hook: DesiredHook, dependencies: ResolvedDependencies): Promise<void> {
  const existing = await requireOneManagedHook(hook, dependencies)
  await retryMutation(
    () => dependencies.updateHook(hook.repo, existing.id, hook.url, hook.events, hook.secret),
    dependencies,
  )
  await pingWithRetry(hook.repo, existing.id, dependencies)
}

async function pingWithRetry(repo: string, hookId: number, dependencies: ResolvedDependencies): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= dependencies.mutationAttempts; attempt += 1) {
    try {
      await dependencies.pingHook(repo, hookId)
      return
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (/status (?:401|403)\b/.test(message)) throw err
      if (attempt < dependencies.mutationAttempts) await dependencies.sleep(dependencies.mutationRetryMs * attempt)
    }
  }
  throw lastError
}

async function transitionSiteProfile(
  filesInput: FleetFiles,
  profile: 'stars' | 'alerts',
  entry: GitHubFleetManifestRepository,
  retiring: { name: string; value: string },
  retiringExistsRemotely: boolean,
  dependencies: ResolvedDependencies,
): Promise<FleetFiles> {
  let files = filesInput
  const subscriptionName = githubFleetSubscriptionName(SITE_REPOSITORY, profile)
  const hook = () => desiredHook(files.routes, files.manifest, SITE_REPOSITORY, profile)

  if (retiringExistsRemotely) {
    let routesText = updateSubscriptionAuth(files.routesText, subscriptionName, retiring.name, [entry.hmac.name])
    files = await writeRoutesAndSync(files, routesText, [subscriptionName], dependencies)
    await waitForRouteStatus(hook(), 200, dependencies, retiring.value)
    await waitForRouteStatus(hook(), 200, dependencies, entry.hmac.value)

    await patchAndPingManagedHook(hook(), dependencies)

    routesText = updateSubscriptionAuth(files.routesText, subscriptionName, entry.hmac.name, [retiring.name])
    files = await writeRoutesAndSync(files, routesText, [subscriptionName], dependencies)
    await waitForRouteStatus(hook(), 200, dependencies, entry.hmac.value)
    await waitForRouteStatus(hook(), 200, dependencies, retiring.value)
  }

  const contracted = updateSubscriptionAuth(files.routesText, subscriptionName, entry.hmac.name)
  files = await writeRoutesAndSync(files, contracted, [subscriptionName], dependencies)
  await waitForRouteStatus(hook(), 200, dependencies, entry.hmac.value)
  if (dependencies.routeGraceMs > 0) await dependencies.sleep(dependencies.routeGraceMs)
  await waitForRouteStatus(hook(), 401, dependencies, retiring.value)
  await patchAndPingManagedHook(hook(), dependencies)
  return files
}

export async function consolidateSiteHmacs(
  options: GitHubFleetOptions,
  projectRoot = process.cwd(),
  dependenciesInput: GitHubFleetReconcileDependencies = {},
): Promise<boolean> {
  const dependencies = resolvedDependencies(dependenciesInput)
  let files = await readFleetFiles(options, projectRoot, dependencies)
  const entry = files.manifest.repositories[SITE_REPOSITORY]
  if (!entry?.retiringHmacs) return false
  const secretNames = await dependencies.listSecrets()
  if (!secretNames.has(entry.hmac.name)) throw new Error(`${SITE_REPOSITORY}: canonical Wrangler HMAC is missing`)

  for (const profile of ['stars', 'alerts'] as const) {
    const retiring = entry.retiringHmacs[profile]
    if (!retiring) continue
    files = await transitionSiteProfile(
      files,
      profile,
      entry,
      retiring,
      secretNames.has(retiring.name),
      dependencies,
    )
  }

  const retiringNames = Object.values(entry.retiringHmacs).map(({ name }) => name)
  const existingRetiringNames = retiringNames.filter((name) => secretNames.has(name))
  if (existingRetiringNames.length > 0) await dependencies.deleteSecrets(existingRetiringNames)

  let devVarsText = files.devVarsText
  for (const retiring of Object.values(entry.retiringHmacs)) {
    const localValue = getDevVar(devVarsText, retiring.name)
    if (localValue !== null && localValue !== retiring.value) {
      throw new Error(`${SITE_REPOSITORY}: local retiring HMAC ${retiring.name} disagrees with the manifest`)
    }
    if (localValue !== null) devVarsText = removeDevVar(devVarsText, retiring.name)
  }
  await writePrivateText(files.devVarsPath, devVarsText, dependencies.planDependencies?.fileSystem)

  const manifest: GitHubFleetManifest = {
    ...files.manifest,
    repositories: {
      ...files.manifest.repositories,
      [SITE_REPOSITORY]: {
        hmac: entry.hmac,
        slugs: entry.slugs,
      },
    },
  }
  await writePrivateText(
    files.manifestPath,
    serializeGitHubFleetManifest(manifest),
    dependencies.planDependencies?.fileSystem,
  )
  return true
}

async function validatePreparedPlan(plan: GitHubFleetPlan): Promise<void> {
  const blockers = [...plan.blockers]
  if (plan.manifestAdditions.length > 0) blockers.push('manifest additions are not prepared')
  if (plan.subscriptionAdditions.length > 0) blockers.push('subscription additions are not prepared')
  if (blockers.length > 0) {
    throw new Error(`GitHub fleet apply is blocked\n${blockers.map((blocker) => `  - ${blocker}`).join('\n')}`)
  }
}

function selectedRepositories(options: GitHubFleetOptions, plan: GitHubFleetPlan): string[] {
  return (options.repositories.length > 0 ? [...options.repositories] : [...plan.discovered]).sort()
}

function verificationRepositories(options: GitHubFleetOptions, plan: GitHubFleetPlan): string[] {
  return [...new Set([...selectedRepositories(options, plan), ...plan.managed])].sort()
}

async function reconcileManagedHook(hook: DesiredHook, dependencies: ResolvedDependencies): Promise<void> {
  let matches = await matchingGitHubRepositoryHooks(await dependencies.listHooks(hook.repo), hook.slugHash)
  if (matches.length > 1) throw new Error(`${hook.subscriptionName}: multiple matching GitHub hooks exist`)
  if (matches.length === 0) {
    let createdId: number | undefined
    try {
      createdId = await retryMutation(
        () => dependencies.createHook(
          hook.repo,
          hook.url,
          hook.secret,
          parseGitHubEventSelection(GITHUB_FLEET_PROFILES[hook.profile].eventProfiles.join(',')),
        ),
        dependencies,
      )
    } catch (err) {
      matches = await matchingGitHubRepositoryHooks(await dependencies.listHooks(hook.repo), hook.slugHash)
      if (matches.length !== 1) throw err
    }
    const hookId = createdId ?? matches[0]!.id
    await pingWithRetry(hook.repo, hookId, dependencies)
    return
  }

  const existing = matches[0]!
  if (!gitHubRepositoryHookMatches(existing, hook.url, hook.events)) {
    await retryMutation(
      () => dependencies.updateHook(hook.repo, existing.id, hook.url, hook.events, hook.secret),
      dependencies,
    )
    await pingWithRetry(hook.repo, existing.id, dependencies)
    return
  }

  try {
    await pingWithRetry(hook.repo, existing.id, dependencies)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/status (?:401|403)\b/.test(message)) throw err
    await retryMutation(
      () => dependencies.updateHook(hook.repo, existing.id, hook.url, hook.events, hook.secret),
      dependencies,
    )
    await pingWithRetry(hook.repo, existing.id, dependencies)
  }
}

export async function applyGitHubFleet(
  options: GitHubFleetOptions,
  projectRoot = process.cwd(),
  dependenciesInput: GitHubFleetReconcileDependencies = {},
): Promise<GitHubFleetApplyResult> {
  const dependencies = resolvedDependencies(dependenciesInput)
  const plan = await planGitHubFleet(options, dependencies.planDependencies, projectRoot)
  await validatePreparedPlan(plan)
  const selected = selectedRepositories(options, plan)
  if (!options.yes) {
    const approved = await dependencies.confirm(
      `Apply GitHub fleet changes for ${selected.join(', ')} after reviewing this plan?\n${formatGitHubFleetPlan(plan)}`,
    )
    if (!approved) throw new Error('GitHub fleet apply cancelled')
  }

  const siteConsolidated = await consolidateSiteHmacs(options, projectRoot, dependenciesInput)
  let files = await readFleetFiles(options, projectRoot, dependencies)
  let secretNames = await dependencies.listSecrets()
  const missingSecrets = selected
    .map((repo) => files.manifest.repositories[repo]?.hmac)
    .filter((secret): secret is SecretValue => secret !== undefined && !secretNames.has(secret.name))
  if (missingSecrets.length > 0) secretNames = await dependencies.putSecrets(missingSecrets)
  for (const repo of selected) {
    const entry = files.manifest.repositories[repo]
    if (!entry) throw new Error(`${repo}: manifest entry is missing`)
    if (!secretNames.has(entry.hmac.name)) throw new Error(`${repo}: Wrangler HMAC is missing after bulk update`)
  }

  const subscriptionNames = selected.flatMap((repo) => (
    GITHUB_FLEET_PROFILE_NAMES.map((profile) => githubFleetSubscriptionName(repo, profile))
  ))
  await syncSubscriptionRoutes(files.routes, subscriptionNames, dependencies, true)
  for (const repo of selected) {
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      await waitForRouteStatus(desiredHook(files.routes, files.manifest, repo, profile), 401, dependencies)
    }
  }
  if (dependencies.routeGraceMs > 0) {
    await dependencies.sleep(dependencies.routeGraceMs)
    for (const repo of selected) {
      for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
        await waitForRouteStatus(desiredHook(files.routes, files.manifest, repo, profile), 401, dependencies)
      }
    }
  }

  let reconciledHooks = 0
  for (const repo of selected) {
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      await reconcileManagedHook(desiredHook(files.routes, files.manifest, repo, profile), dependencies)
      reconciledHooks += 1
    }
  }
  return { selected, installedSecrets: missingSecrets.length, reconciledHooks, siteConsolidated }
}

async function remoteRouteIssues(
  routes: Routes,
  repositories: readonly string[],
  dependencies: ResolvedDependencies,
): Promise<string[]> {
  const names = repositories.flatMap((repo) => (
    GITHUB_FLEET_PROFILE_NAMES.map((profile) => githubFleetSubscriptionName(repo, profile))
  ))
  const keys = targetSubscriptionKeys(routes, names)
  const plan = computePlan(routes, await dependencies.readKv())
  return plan.subPuts
    .filter((put) => keys.has(put.key))
    .map((put) => `production KV differs for ${names.find((name) => subscriptionKvKey(namedSubscription(routes, name).slugHash) === put.key)}`)
    .concat(plan.sinkPuts.map((put) => `production KV differs for ${put.key}`))
}

export async function verifyGitHubFleet(
  options: GitHubFleetOptions,
  projectRoot = process.cwd(),
  dependenciesInput: GitHubFleetReconcileDependencies = {},
): Promise<GitHubFleetVerifyResult> {
  const dependencies = resolvedDependencies(dependenciesInput)
  const plan = await planGitHubFleet(options, dependencies.planDependencies, projectRoot)
  const issues = [...plan.blockers]
  if (plan.manifestAdditions.length > 0) issues.push('manifest additions are not prepared')
  if (plan.subscriptionAdditions.length > 0) issues.push('subscription additions are not prepared')
  const repositories = verificationRepositories(options, plan)
  const files = await readFleetFiles(options, projectRoot, dependencies)
  const secretNames = await dependencies.listSecrets()
  issues.push(...await remoteRouteIssues(files.routes, repositories, dependencies))

  for (const repo of repositories) {
    const entry = files.manifest.repositories[repo]
    if (!entry) {
      issues.push(`${repo}: manifest entry is missing`)
      continue
    }
    if (!secretNames.has(entry.hmac.name)) issues.push(`${repo}: Wrangler HMAC is missing`)
    if (entry.retiringHmacs) issues.push(`${repo}: HMAC consolidation is incomplete`)
  }
  if (files.manifest.repositories[SITE_REPOSITORY]) {
    for (const name of SITE_RETIRING_SECRET_NAMES) {
      if (secretNames.has(name)) issues.push(`${SITE_REPOSITORY}: retiring Wrangler HMAC remains: ${name}`)
      if (getDevVar(files.devVarsText, name) !== null) issues.push(`${SITE_REPOSITORY}: retiring local HMAC remains: ${name}`)
    }
  }

  let verifiedHooks = 0
  for (const repo of repositories) {
    if (!files.manifest.repositories[repo]) continue
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      const hook = desiredHook(files.routes, files.manifest, repo, profile)
      try {
        await waitForRouteStatus(hook, 401, dependencies)
        const existing = await requireOneManagedHook(hook, dependencies)
        if (!gitHubRepositoryHookMatches(existing, hook.url, hook.events)) {
          issues.push(`${hook.subscriptionName}: GitHub hook metadata differs`)
          continue
        }
        await pingWithRetry(repo, existing.id, dependencies)
        verifiedHooks += 1
      } catch (err) {
        issues.push(err instanceof Error ? err.message : String(err))
      }
    }
  }
  return { repositories, verifiedHooks, issues }
}
