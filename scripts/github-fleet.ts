import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, parse as parseJsonc, type FormattingOptions, type ParseError } from 'jsonc-parser'
import type { GitHubFleetDiscovery, GitHubFleetDiscoveryOptions } from './github-fleet-discovery'
import { discoverGitHubFleet } from './github-fleet-discovery'
import {
  generateGitHubFleetManifestRepository,
  githubFleetManifestValues,
  parseGitHubFleetManifest,
  serializeGitHubFleetManifest,
  withGitHubFleetManifestRepository,
  type GitHubFleetManifest,
  type GitHubFleetManifestRepository,
  type GitHubFleetRandomValues,
} from './github-fleet-manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  GITHUB_FLEET_PROFILES,
  buildGitHubFleetSubscription,
  githubFleetHmacName,
  githubFleetSubscriptionName,
  type GitHubFleetProfileName,
  type GitHubFleetSubscription,
} from './github-fleet-model'
import {
  gitHubRepositoryHookSlug,
  listGitHubRepositoryHooks,
  matchingGitHubRepositoryHooks,
  requireMatchingGitHubRepositoryHook,
  type GitHubRepositoryHook,
} from './github-repository'
import { readRemoteKvSnapshot, type RemoteKvSnapshot } from './kv'
import {
  getDevVar,
  listWranglerSecrets,
  privateFileIssue,
  readPrivateOptionalText,
  setDevVar,
  writePrivateText,
  writeText,
  type AtomicFileSystem,
} from './setup'
import { computePlan, parseRoutes, type Routes, type Sub } from './sync'

const DEFAULT_SECRET_LIMIT = 64
const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const WRANGLER_FILE = 'wrangler.jsonc'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

export type GitHubFleetPhase = 'plan' | 'prepare' | 'apply' | 'verify'

export interface GitHubFleetOptions {
  phase: GitHubFleetPhase
  root: string
  manifest: string
  repositories: string[]
  includePrivate: boolean
  secretLimit: number
  yes: boolean
}

export interface GitHubFleetCapacity {
  vars: number
  existingSecrets: number
  plannedSecrets: number
  projected: number
  limit: number
}

export interface GitHubFleetPlan {
  discovered: string[]
  selected: string[]
  managed: string[]
  exclusions: GitHubFleetDiscovery['exclusions']
  blockers: string[]
  manifestAdditions: string[]
  subscriptionAdditions: string[]
  hookAdditions: string[]
  routeDrift: string[]
  remoteKvPuts: number
  remoteKvDeletes: number
  capacity: GitHubFleetCapacity
}

export interface GitHubFleetPrepareResult {
  repositories: string[]
  manifestAdditions: number
  devVarAdditions: number
  subscriptionAdditions: number
}

export interface GitHubFleetDependencies {
  discover(root: string, options?: GitHubFleetDiscoveryOptions): Promise<GitHubFleetDiscovery>
  listHooks(repo: string): Promise<GitHubRepositoryHook[]>
  listSecrets(): Promise<Set<string>>
  readKv(): Promise<RemoteKvSnapshot>
  randomValues?: GitHubFleetRandomValues
  fileSystem?: AtomicFileSystem
}

const DEFAULT_DEPENDENCIES: GitHubFleetDependencies = {
  discover: discoverGitHubFleet,
  listHooks: listGitHubRepositoryHooks,
  listSecrets: listWranglerSecrets,
  readKv: readRemoteKvSnapshot,
}

interface FleetLocalState {
  routesText: string
  routes: Routes
  devVarsText: string
  manifestText: string
  manifest: GitHubFleetManifest
  hooks: Map<string, GitHubRepositoryHook[]>
  discovery: GitHubFleetDiscovery
  selected: Set<string>
  managed: Set<string>
  target: Set<string>
  blockers: string[]
  manifestAdditions: string[]
}

interface FleetPaths {
  root: string
  manifest: string
  routes: string
  devVars: string
  wrangler: string
}

function usage(): string {
  return [
    'usage: pnpm github:fleet <plan|prepare|apply|verify> --root <directory> --manifest <file> [options]',
    '',
    'options:',
    '  --repo <owner/repo>    select a new repository, repeatable',
    '  --include-private       admit private repositories selected with --repo',
    `  --secret-limit <count> Worker variable and secret limit (default: ${DEFAULT_SECRET_LIMIT})`,
    '  -y, --yes              apply production changes without prompts',
    '  -h, --help             show this help',
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseGitHubFleetArgs(argv: string[]): GitHubFleetOptions {
  const phase = argv[0]
  if (phase === '--help' || phase === '-h') throw new Error(usage())
  if (!phase || !['plan', 'prepare', 'apply', 'verify'].includes(phase)) throw new Error(usage())
  let root: string | undefined
  let manifest: string | undefined
  const repositories: string[] = []
  let includePrivate = false
  let secretLimit = DEFAULT_SECRET_LIMIT
  let yes = false

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--root') {
      if (root !== undefined) throw new Error('--root may only be supplied once')
      root = optionValue(argv, index, arg)
      index += 1
    } else if (arg === '--manifest') {
      if (manifest !== undefined) throw new Error('--manifest may only be supplied once')
      manifest = optionValue(argv, index, arg)
      index += 1
    } else if (arg === '--repo') {
      const repo = optionValue(argv, index, arg)
      if (repositories.includes(repo)) throw new Error(`--repo supplied more than once: ${repo}`)
      repositories.push(repo)
      index += 1
    } else if (arg === '--include-private') {
      includePrivate = true
    } else if (arg === '--secret-limit') {
      const raw = optionValue(argv, index, arg)
      secretLimit = Number(raw)
      if (!Number.isSafeInteger(secretLimit) || secretLimit < 1) throw new Error('--secret-limit must be a positive integer')
      index += 1
    } else if (arg === '--yes' || arg === '-y') {
      yes = true
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(usage())
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (!root) throw new Error('--root is required')
  if (!manifest) throw new Error('--manifest is required')
  if (includePrivate && repositories.length === 0) throw new Error('--include-private requires at least one --repo')
  if (yes && phase !== 'apply') throw new Error('-y is only valid with apply')
  return { phase: phase as GitHubFleetPhase, root, manifest, repositories, includePrivate, secretLimit, yes }
}

function fleetDiscoveryOptions(options: GitHubFleetOptions): GitHubFleetDiscoveryOptions {
  return {
    privateRepositories: new Set(options.includePrivate ? options.repositories : []),
  }
}

function fleetPaths(options: GitHubFleetOptions, projectRoot: string): FleetPaths {
  return {
    root: resolve(projectRoot, options.root),
    manifest: resolve(projectRoot, options.manifest),
    routes: resolve(projectRoot, ROUTES_FILE),
    devVars: resolve(projectRoot, DEV_VARS_FILE),
    wrangler: resolve(projectRoot, WRANGLER_FILE),
  }
}

function routeMap(routes: Routes): Map<string, Sub> {
  return new Map(routes.subs.map((sub) => [sub.name, sub]))
}

function profileRoutes(routes: Routes, repo: string): Partial<Record<GitHubFleetProfileName, Sub>> {
  const byName = routeMap(routes)
  const result: Partial<Record<GitHubFleetProfileName, Sub>> = {}
  for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
    const sub = byName.get(githubFleetSubscriptionName(repo, profile))
    if (sub) result[profile] = sub
  }
  return result
}

function referencedSecretNames(sub: Sub): string[] {
  if (!sub.auth) return []
  return [sub.auth.secretEnv, ...(sub.auth.alternateSecretEnvs ?? [])]
}

async function recoverManifestRepository(
  repo: string,
  routes: Partial<Record<GitHubFleetProfileName, Sub>>,
  hooks: GitHubRepositoryHook[],
  devVarsText: string,
): Promise<GitHubFleetManifestRepository> {
  const canonicalName = githubFleetHmacName(repo)
  const canonicalValue = getDevVar(devVarsText, canonicalName)
  if (canonicalValue === null) throw new Error(`${repo}: ${canonicalName} is missing from .dev.vars`)

  const slugs = {} as Record<GitHubFleetProfileName, string>
  for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
    const sub = routes[profile]
    if (!sub?.auth) throw new Error(`${repo}: ${profile} route is missing authenticated configuration`)
    const secretNames = referencedSecretNames(sub)
    if (secretNames.length !== 1 || secretNames[0] !== canonicalName) {
      throw new Error(`${repo}: ${profile} route must reference only ${canonicalName} before it can be imported`)
    }
    const hook = await requireMatchingGitHubRepositoryHook(hooks, sub.slugHash, sub.name, repo)
    const slug = gitHubRepositoryHookSlug(hook)
    if (!slug) throw new Error(`${repo}: ${profile} webhook does not have a recoverable Hookrelay URL`)
    slugs[profile] = slug
  }

  return {
    hmac: { name: canonicalName, value: canonicalValue },
    slugs,
  }
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return sameStrings(left, right)
}

function sameSubscriptionFilter(left: Sub['filter'], right: GitHubFleetSubscription['filter']): boolean {
  if (left === undefined || right === undefined) return left === right
  return sameOptionalStrings(left.eventTypes.include, right.eventTypes.include)
    && sameOptionalStrings(left.eventTypes.exclude, right.eventTypes.exclude)
}

async function fleetRouteIssues(
  repo: string,
  profile: GitHubFleetProfileName,
  sub: Sub,
  entry: GitHubFleetManifestRepository,
): Promise<string[]> {
  const issues: string[] = []
  const desired = await buildGitHubFleetSubscription(repo, profile, githubFleetManifestValues(entry))
  if (sub.source !== desired.source) issues.push('source')
  if (sub.slugHash !== desired.slugHash) issues.push('slug hash')
  if (sub.enabled !== desired.enabled) issues.push('enabled state')
  if (!sameStrings(sub.sinks, desired.sinks)) issues.push('sink mapping')
  if (!sameSubscriptionFilter(sub.filter, desired.filter)) issues.push('delivery filter')
  if (sub.setup?.github?.repo !== repo) issues.push('GitHub repository metadata')
  if (!sameStrings(sub.setup?.github?.eventProfiles, desired.setup.github.eventProfiles)) issues.push('event profiles')
  if (!sub.auth || sub.auth.scheme !== desired.auth.scheme) {
    issues.push('authentication scheme')
  } else {
    const actualNames = referencedSecretNames(sub)
    if (actualNames.length !== 1 || actualNames[0] !== entry.hmac.name) {
      issues.push('authentication references')
    }
  }
  return issues
}

async function readHooks(
  discovery: GitHubFleetDiscovery,
  dependencies: GitHubFleetDependencies,
  blockers: string[],
): Promise<Map<string, GitHubRepositoryHook[]>> {
  const hooks = new Map<string, GitHubRepositoryHook[]>()
  for (const repository of discovery.repositories) {
    try {
      hooks.set(repository.nameWithOwner, await dependencies.listHooks(repository.nameWithOwner))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      blockers.push(`${repository.nameWithOwner}: webhook lookup failed (${message})`)
    }
  }
  return hooks
}

async function loadLocalState(
  options: GitHubFleetOptions,
  projectRoot: string,
  dependencies: GitHubFleetDependencies,
  generateSelected: boolean,
): Promise<FleetLocalState> {
  const paths = fleetPaths(options, projectRoot)
  const discovery = await dependencies.discover(paths.root, fleetDiscoveryOptions(options))
  const blockers = [...discovery.blockers]
  const manifestIssue = await privateFileIssue(paths.manifest, dependencies.fileSystem)
  const devVarsIssue = await privateFileIssue(paths.devVars, dependencies.fileSystem)
  if (manifestIssue) blockers.push(manifestIssue)
  if (devVarsIssue) blockers.push(devVarsIssue)
  if (manifestIssue || devVarsIssue) {
    throw new Error(blockers.join('\n'))
  }

  const [routesText, devVarsText, manifestText] = await Promise.all([
    readFile(paths.routes, 'utf8'),
    readPrivateOptionalText(paths.devVars, dependencies.fileSystem),
    readPrivateOptionalText(paths.manifest, dependencies.fileSystem),
  ])
  const routes = parseRoutes(routesText)
  let manifest = parseGitHubFleetManifest(manifestText)
  const discoveredNames = new Set(discovery.repositories.map((repo) => repo.nameWithOwner))
  const selected = new Set(options.repositories.length > 0 ? options.repositories : discoveredNames)
  for (const repo of selected) {
    if (!discoveredNames.has(repo)) {
      const eligibleVisibility = options.includePrivate
        ? 'an eligible public or explicitly selected private repository'
        : 'an eligible public repository; private repositories require --include-private'
      blockers.push(`${repo}: selected repository was not discovered as ${eligibleVisibility}`)
    }
  }

  const hooks = await readHooks(discovery, dependencies, blockers)
  const manifestAdditions: string[] = []
  const managed = new Set(Object.keys(manifest.repositories).filter((repo) => discoveredNames.has(repo)))
  for (const repo of discoveredNames) {
    const existingRoutes = profileRoutes(routes, repo)
    const routeCount = Object.keys(existingRoutes).length
    if (routeCount > 0) managed.add(repo)
    if (routeCount !== 0 && routeCount !== GITHUB_FLEET_PROFILE_NAMES.length) {
      blockers.push(`${repo}: only ${routeCount} of the three fleet subscriptions exist`)
      continue
    }

    if (!manifest.repositories[repo] && routeCount === GITHUB_FLEET_PROFILE_NAMES.length) {
      const repoHooks = hooks.get(repo)
      if (!repoHooks) continue
      try {
        const recovered = await recoverManifestRepository(repo, existingRoutes, repoHooks, devVarsText)
        manifest = withGitHubFleetManifestRepository(manifest, repo, recovered)
        manifestAdditions.push(repo)
      } catch (err) {
        blockers.push(err instanceof Error ? err.message : String(err))
      }
    } else if (!manifest.repositories[repo] && routeCount === 0 && selected.has(repo) && generateSelected) {
      try {
        const generated = generateGitHubFleetManifestRepository(repo, dependencies.randomValues)
        manifest = withGitHubFleetManifestRepository(manifest, repo, generated)
        manifestAdditions.push(repo)
        managed.add(repo)
      } catch (err) {
        blockers.push(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const target = new Set([...selected, ...managed])
  return {
    routesText,
    routes,
    devVarsText,
    manifestText,
    manifest,
    hooks,
    discovery,
    selected,
    managed,
    target,
    blockers,
    manifestAdditions,
  }
}

export function countWranglerTextVars(text: string): number {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0 || parsed === null || typeof parsed !== 'object') {
    throw new Error('failed to parse wrangler.jsonc for variable capacity')
  }
  const vars = (parsed as Record<string, unknown>).vars
  if (vars === undefined) return 0
  if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
    throw new Error('wrangler.jsonc vars must be an object')
  }
  return Object.keys(vars).length
}

function plannedRepositoryNames(state: FleetLocalState): string[] {
  return [...state.target]
    .filter((repo) => state.discovery.repositories.some((candidate) => candidate.nameWithOwner === repo))
    .sort()
}

export async function planGitHubFleet(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetPlan> {
  const paths = fleetPaths(options, projectRoot)
  const fileIssues = (await Promise.all([
    privateFileIssue(paths.manifest, dependencies.fileSystem),
    privateFileIssue(paths.devVars, dependencies.fileSystem),
  ])).filter((issue): issue is string => issue !== null)
  if (fileIssues.length > 0) {
    const discovery = await dependencies.discover(paths.root, fleetDiscoveryOptions(options))
    const selected = options.repositories.length > 0
      ? [...options.repositories].sort()
      : discovery.repositories.map((repo) => repo.nameWithOwner)
    return {
      discovered: discovery.repositories.map((repo) => repo.nameWithOwner),
      selected,
      managed: [],
      exclusions: discovery.exclusions,
      blockers: [...discovery.blockers, ...fileIssues],
      manifestAdditions: [],
      subscriptionAdditions: [],
      hookAdditions: [],
      routeDrift: [],
      remoteKvPuts: 0,
      remoteKvDeletes: 0,
      capacity: {
        vars: 0,
        existingSecrets: 0,
        plannedSecrets: 0,
        projected: 0,
        limit: options.secretLimit,
      },
    }
  }
  const state = await loadLocalState(options, projectRoot, dependencies, false)
  const blockers = [...state.blockers]
  const subscriptionAdditions: string[] = []
  const hookAdditions: string[] = []
  const routeDrift: string[] = []
  const selectedNames = [...state.selected].sort()
  const manifestAdditions = [...state.manifestAdditions]

  for (const sink of Object.values(GITHUB_FLEET_PROFILES).map((profile) => profile.sink)) {
    if (!state.routes.sinks.some((candidate) => candidate.name === sink)) blockers.push(`required sink is missing: ${sink}`)
  }

  for (const repo of selectedNames) {
    if (!state.manifest.repositories[repo] && !manifestAdditions.includes(repo)) manifestAdditions.push(repo)
  }

  for (const repo of plannedRepositoryNames(state)) {
    const entry = state.manifest.repositories[repo]
    const existingRoutes = profileRoutes(state.routes, repo)
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      const name = githubFleetSubscriptionName(repo, profile)
      const sub = existingRoutes[profile]
      if (!sub) {
        subscriptionAdditions.push(name)
        hookAdditions.push(name)
        continue
      }
      if (entry) {
        const issues = await fleetRouteIssues(repo, profile, sub, entry)
        if (issues.length > 0) routeDrift.push(`${name}: ${issues.join(', ')}`)
      }
      const repoHooks = state.hooks.get(repo)
      if (repoHooks) {
        const matches = await matchingGitHubRepositoryHooks(repoHooks, sub.slugHash)
        if (matches.length === 0) hookAdditions.push(name)
        else if (matches.length > 1) blockers.push(`${name}: multiple matching GitHub hooks in ${repo}`)
      }
    }
  }
  blockers.push(...routeDrift.map((issue) => `route drift: ${issue}`))

  const [wranglerText, existingSecrets, remoteKv] = await Promise.all([
    readFile(paths.wrangler, 'utf8'),
    dependencies.listSecrets(),
    dependencies.readKv(),
  ])
  const vars = countWranglerTextVars(wranglerText)
  const requiredSinkNames = new Set<string>(Object.values(GITHUB_FLEET_PROFILES).map((profile) => profile.sink))
  for (const sink of state.routes.sinks.filter((candidate) => requiredSinkNames.has(candidate.name))) {
    for (const [field, value] of Object.entries(sink)) {
      if (field.endsWith('Env') && typeof value === 'string' && !existingSecrets.has(value)) {
        blockers.push(`required sink ${sink.name} references missing Wrangler secret ${value}`)
      }
    }
  }
  const plannedSecretNames = new Set<string>()
  for (const repo of plannedRepositoryNames(state)) {
    const entry = state.manifest.repositories[repo]
    const hmacName = entry?.hmac.name ?? githubFleetHmacName(repo)
    if (!existingSecrets.has(hmacName)) plannedSecretNames.add(hmacName)
  }
  const projected = vars + existingSecrets.size + plannedSecretNames.size
  const capacity: GitHubFleetCapacity = {
    vars,
    existingSecrets: existingSecrets.size,
    plannedSecrets: plannedSecretNames.size,
    projected,
    limit: options.secretLimit,
  }
  if (projected > options.secretLimit) blockers.push(`projected Worker variables and secrets ${projected} exceed limit ${options.secretLimit}`)

  const kvPlan = computePlan(state.routes, remoteKv)
  return {
    discovered: state.discovery.repositories.map((repo) => repo.nameWithOwner),
    selected: selectedNames,
    managed: [...state.managed].sort(),
    exclusions: state.discovery.exclusions,
    blockers,
    manifestAdditions: manifestAdditions.sort(),
    subscriptionAdditions: subscriptionAdditions.sort(),
    hookAdditions: hookAdditions.sort(),
    routeDrift: routeDrift.sort(),
    remoteKvPuts: kvPlan.subPuts.length + kvPlan.sinkPuts.length,
    remoteKvDeletes: kvPlan.subDeletes.length + kvPlan.sinkDeletes.length,
    capacity,
  }
}

function appendSubscription(text: string, subscription: GitHubFleetSubscription): string {
  const updated = applyEdits(text, modify(text, ['subs', -1], subscription, {
    isArrayInsertion: true,
    formattingOptions: FORMATTING_OPTIONS,
  }))
  return updated.endsWith('\n') ? updated : `${updated}\n`
}

export async function prepareGitHubFleet(
  options: GitHubFleetOptions,
  dependencies: GitHubFleetDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<GitHubFleetPrepareResult> {
  const preview = await planGitHubFleet({ ...options, phase: 'plan', yes: false }, dependencies, projectRoot)
  if (preview.blockers.length > 0) {
    throw new Error(`GitHub fleet preparation blocked\n${preview.blockers.map((item) => `  - ${item}`).join('\n')}`)
  }
  const state = await loadLocalState(options, projectRoot, dependencies, true)
  const paths = fleetPaths(options, projectRoot)
  const blockers = [...state.blockers]
  let routesText = state.routesText
  let routes = state.routes
  let devVarsText = state.devVarsText
  let devVarAdditions = 0
  let subscriptionAdditions = 0

  for (const sink of Object.values(GITHUB_FLEET_PROFILES).map((profile) => profile.sink)) {
    if (!routes.sinks.some((candidate) => candidate.name === sink)) blockers.push(`required sink is missing: ${sink}`)
  }

  for (const repo of plannedRepositoryNames(state)) {
    const entry = state.manifest.repositories[repo]
    if (!entry) {
      blockers.push(`${repo}: manifest values are unavailable`)
      continue
    }
    const existingRoutes = profileRoutes(routes, repo)
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      const existing = existingRoutes[profile]
      if (existing) {
        const issues = await fleetRouteIssues(repo, profile, existing, entry)
        if (issues.length > 0) blockers.push(`${existing.name}: ${issues.join(', ')}`)
      } else {
        const desired = await buildGitHubFleetSubscription(repo, profile, githubFleetManifestValues(entry))
        const hashOwner = routes.subs.find((sub) => sub.slugHash === desired.slugHash)
        if (hashOwner) blockers.push(`${desired.name}: subscription slug hash is already used by ${hashOwner.name}`)
      }
    }
  }
  if (blockers.length > 0) throw new Error(`GitHub fleet preparation blocked\n${blockers.map((item) => `  - ${item}`).join('\n')}`)

  await writePrivateText(paths.manifest, serializeGitHubFleetManifest(state.manifest), dependencies.fileSystem)

  for (const entry of Object.values(state.manifest.repositories)) {
    const beforeCanonical = getDevVar(devVarsText, entry.hmac.name)
    devVarsText = setDevVar(devVarsText, entry.hmac.name, entry.hmac.value)
    if (beforeCanonical === null) devVarAdditions += 1
  }
  await writePrivateText(paths.devVars, devVarsText, dependencies.fileSystem)

  for (const repo of plannedRepositoryNames(state)) {
    const entry = state.manifest.repositories[repo]!
    const existingNames = new Set(routes.subs.map((sub) => sub.name))
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      const name = githubFleetSubscriptionName(repo, profile)
      if (existingNames.has(name)) continue
      const subscription = await buildGitHubFleetSubscription(repo, profile, githubFleetManifestValues(entry))
      if (routes.subs.some((sub) => sub.slugHash === subscription.slugHash)) {
        throw new Error(`${name}: subscription slug hash collides with an existing route`)
      }
      routesText = appendSubscription(routesText, subscription)
      routes = parseRoutes(routesText)
      existingNames.add(name)
      subscriptionAdditions += 1
    }
  }
  await writeText(paths.routes, routesText, dependencies.fileSystem)
  return {
    repositories: plannedRepositoryNames(state),
    manifestAdditions: state.manifestAdditions.length,
    devVarAdditions,
    subscriptionAdditions,
  }
}

export function formatGitHubFleetPlan(plan: GitHubFleetPlan): string {
  const lines = [
    `Discovered repositories: ${plan.discovered.length}`,
    `Selected repositories: ${plan.selected.length}`,
    `Managed repositories: ${plan.managed.length}`,
    `Manifest additions: ${plan.manifestAdditions.length}`,
    `Subscription additions: ${plan.subscriptionAdditions.length}`,
    `GitHub hook additions: ${plan.hookAdditions.length}`,
    `Production KV puts: ${plan.remoteKvPuts}`,
    `Production KV deletes: ${plan.remoteKvDeletes}`,
    `Worker capacity: ${plan.capacity.projected}/${plan.capacity.limit}`,
  ]
  for (const exclusion of plan.exclusions) lines.push(`EXCLUDE ${exclusion.child}: ${exclusion.reason}`)
  for (const repo of plan.manifestAdditions) lines.push(`ADD manifest ${repo}`)
  for (const name of plan.subscriptionAdditions) lines.push(`ADD subscription ${name}`)
  for (const name of plan.hookAdditions) lines.push(`ADD hook ${name}`)
  for (const blocker of plan.blockers) lines.push(`BLOCK ${blocker}`)
  return lines.join('\n')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return
  }
  const options = parseGitHubFleetArgs(argv)
  if (options.phase === 'plan') {
    const plan = await planGitHubFleet(options)
    console.log(formatGitHubFleetPlan(plan))
    if (plan.blockers.length > 0) process.exitCode = 1
    return
  }
  if (options.phase === 'prepare') {
    const result = await prepareGitHubFleet(options)
    console.log(`Prepared ${result.repositories.length} repositories`)
    console.log(`Manifest additions: ${result.manifestAdditions}`)
    console.log(`Local secret additions: ${result.devVarAdditions}`)
    console.log(`Subscription additions: ${result.subscriptionAdditions}`)
    return
  }
  const { applyGitHubFleet, verifyGitHubFleet } = await import('./github-fleet-reconcile')
  if (options.phase === 'apply') {
    const preview = await planGitHubFleet(options)
    console.log(formatGitHubFleetPlan(preview))
    const result = await applyGitHubFleet(options)
    console.log(`Installed repository HMACs: ${result.installedSecrets}`)
    console.log(`Reconciled GitHub hooks: ${result.reconciledHooks}`)
    return
  }
  const result = await verifyGitHubFleet(options)
  console.log(`Verified repositories: ${result.repositories.length}`)
  console.log(`Verified GitHub hooks: ${result.verifiedHooks}`)
  for (const issue of result.issues) console.log(`ISSUE ${issue}`)
  if (result.issues.length > 0) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
