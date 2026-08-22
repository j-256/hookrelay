import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { subscriptionKvKey } from '../src/lib/subscription'
import {
  deleteGitHubRepositoryHook,
  listGitHubRepositoryHooks,
  matchingGitHubRepositoryHooks,
  type GitHubRepositoryHook,
} from './providers/github/repository-hooks'
import { readRemoteKvSnapshot, type RemoteKvSnapshot } from './kv'
import {
  archiveSubscription,
  captureSecretValues,
  parseRetirementManifest,
  routeReferencesSecret,
  serializeRetirementManifest,
  subscriptionSecretNames,
  type RetirementManifest,
  type SubscriptionRetirementArchive,
} from './retirement-manifest'
import { disableSubscription, removeSubscription } from './retirement-routes'
import {
  confirm,
  deleteWranglerSecretsBulk,
  getDevVar,
  listWranglerSecrets,
  readPrivateOptionalText,
  removeDevVar,
  runSync,
  writePrivateText,
  writeText,
} from './setup'
import { parseRoutes, type Routes, type Sub } from './sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'

export interface SubscriptionRetirementOptions {
  name: string
  manifest: string
  finalize: boolean
  yes: boolean
}

export interface SubscriptionRetirementDependencies {
  readText(path: string): Promise<string>
  readPrivateText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  writePrivateText(path: string, text: string): Promise<void>
  readKv(): Promise<RemoteKvSnapshot>
  runSync(apply: boolean): Promise<void>
  confirm(question: string): Promise<boolean>
  listHooks(repo: string): Promise<GitHubRepositoryHook[]>
  deleteHook(repo: string, id: number): Promise<void>
  listSecrets(): Promise<Set<string>>
  deleteSecrets(names: readonly string[]): Promise<Set<string>>
  log(line: string): void
}

const DEFAULT_DEPENDENCIES: SubscriptionRetirementDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  readPrivateText: readPrivateOptionalText,
  writeText,
  writePrivateText,
  readKv: readRemoteKvSnapshot,
  runSync,
  confirm,
  listHooks: listGitHubRepositoryHooks,
  deleteHook: deleteGitHubRepositoryHook,
  listSecrets: listWranglerSecrets,
  deleteSecrets: deleteWranglerSecretsBulk,
  log: console.log,
}

export function subscriptionRetirementUsage(): string {
  return [
    'usage: pnpm sub:retire <name> --manifest <file> [--finalize] [-y]',
    '',
    'phases:',
    '  default     Disable the local subscription and preview or apply KV',
    '  --finalize  Archive recovery data, remove owned resources, and clean safe secrets',
    '',
    'options:',
    '  --manifest <file>  Private versioned recovery manifest',
    '  -y, --yes          Apply production changes without prompts',
    '  -h, --help         Show this help',
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseSubscriptionRetirementArgs(argv: string[]): SubscriptionRetirementOptions {
  let name: string | undefined
  let manifest: string | undefined
  let finalize = false
  let yes = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--manifest') {
      if (manifest !== undefined) throw new Error('--manifest may only be supplied once')
      manifest = optionValue(argv, index, argument)
      index += 1
    } else if (argument === '--finalize') finalize = true
    else if (argument === '-y' || argument === '--yes') yes = true
    else if (argument === '-h' || argument === '--help') throw new Error(subscriptionRetirementUsage())
    else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    else if (name === undefined) name = argument
    else throw new Error(subscriptionRetirementUsage())
  }
  if (!name || !manifest) throw new Error(subscriptionRetirementUsage())
  return { name, manifest, finalize, yes }
}

function localSubscription(routes: Routes, name: string): Sub | undefined {
  const matches = routes.subs.filter((subscription) => subscription.name === name)
  if (matches.length > 1) throw new Error(`subscription is declared more than once: ${name}`)
  return matches[0]
}

function updateArchive(
  manifest: RetirementManifest,
  name: string,
  update: Partial<SubscriptionRetirementArchive>,
): RetirementManifest {
  const existing = manifest.subscriptions[name]
  if (!existing) throw new Error(`subscription retirement archive is missing: ${name}`)
  return {
    ...manifest,
    subscriptions: {
      ...manifest.subscriptions,
      [name]: { ...existing, ...update },
    },
  }
}

function assertRemoteDisabled(
  subscription: Sub,
  remote: RemoteKvSnapshot,
  archive: SubscriptionRetirementArchive | undefined,
): void {
  const key = subscriptionKvKey(subscription.slugHash)
  const value = remote.subs[key]
  if (value === undefined) {
    if (archive?.localRemoved || archive?.kvRemoved) return
    throw new Error(`subscription ${subscription.name} is not present in production KV; apply the disable phase first`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`subscription ${subscription.name} has invalid production KV configuration`)
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>).enabled !== false) {
    throw new Error(`subscription ${subscription.name} is not disabled in production KV`)
  }
}

async function persistManifest(
  path: string,
  manifest: RetirementManifest,
  dependencies: SubscriptionRetirementDependencies,
): Promise<void> {
  await dependencies.writePrivateText(path, serializeRetirementManifest(manifest))
}

async function prepareSubscriptionRetirement(
  options: SubscriptionRetirementOptions,
  paths: { routes: string; manifest: string },
  dependencies: SubscriptionRetirementDependencies,
): Promise<'prepared' | 'applied' | 'cancelled' | 'complete'> {
  const [routesText, manifestText] = await Promise.all([
    dependencies.readText(paths.routes),
    dependencies.readPrivateText(paths.manifest),
  ])
  const manifest = parseRetirementManifest(manifestText)
  const routes = parseRoutes(routesText)
  const local = localSubscription(routes, options.name)
  if (!local) {
    const archive = manifest.subscriptions[options.name]
    if (archive?.kvRemoved && archive.secretsRemoved && (!archive.hook || archive.hook.deleted)) {
      dependencies.log(`Subscription retirement is already complete: ${options.name}`)
      return 'complete'
    }
    if (archive?.localRemoved) {
      throw new Error(`subscription ${options.name} finalization is in progress; rerun with --finalize`)
    }
    throw new Error(`subscription does not exist: ${options.name}`)
  }
  const disabled = disableSubscription(routesText, options.name)
  await persistManifest(paths.manifest, manifest, dependencies)
  if (disabled.changed) await dependencies.writeText(paths.routes, disabled.routesText)
  dependencies.log(`${disabled.changed ? 'Disabled' : 'Already disabled'} subscription ${options.name} locally`)
  await dependencies.runSync(false)
  if (!options.yes && !(await dependencies.confirm(`Apply the disabled subscription ${options.name} to production KV?`))) {
    dependencies.log('Production KV was not changed')
    return 'cancelled'
  }
  await dependencies.runSync(true)
  dependencies.log(`Applied disabled subscription ${options.name}`)
  return options.yes ? 'applied' : 'prepared'
}

async function plannedGitHubHook(
  subscription: Sub,
  archive: SubscriptionRetirementArchive,
  dependencies: SubscriptionRetirementDependencies,
): Promise<SubscriptionRetirementArchive['hook']> {
  const repo = subscription.setup?.github?.repo
  if (!repo) return undefined
  if (archive.hook) return archive.hook
  const matches = await matchingGitHubRepositoryHooks(await dependencies.listHooks(repo), subscription.slugHash)
  if (matches.length > 1) throw new Error(`subscription ${subscription.name} has multiple matching GitHub hooks`)
  if (matches.length === 0) return undefined
  return { repo, id: matches[0]!.id, deleted: false }
}

async function deletePlannedHook(
  manifest: RetirementManifest,
  name: string,
  subscription: Sub,
  manifestPath: string,
  dependencies: SubscriptionRetirementDependencies,
): Promise<RetirementManifest> {
  const hook = manifest.subscriptions[name]?.hook
  if (!hook || hook.deleted) return manifest
  const hooks = await dependencies.listHooks(hook.repo)
  const candidate = hooks.find((existing) => existing.id === hook.id)
  if (candidate) {
    const matches = await matchingGitHubRepositoryHooks(hooks, subscription.slugHash)
    if (!matches.some((match) => match.id === candidate.id)) {
      throw new Error(`subscription ${name} planned GitHub hook no longer matches its archived route`)
    }
    await dependencies.deleteHook(hook.repo, hook.id)
  }
  const updated = updateArchive(manifest, name, { hook: { ...hook, deleted: true } })
  await persistManifest(manifestPath, updated, dependencies)
  return updated
}

async function cleanupSubscriptionSecrets(
  manifest: RetirementManifest,
  name: string,
  routes: Routes,
  devVarsText: string,
  devVarsPath: string,
  manifestPath: string,
  dependencies: SubscriptionRetirementDependencies,
): Promise<RetirementManifest> {
  const archive = manifest.subscriptions[name]!
  const deletable = archive.secrets
    .map((secret) => secret.name)
    .filter((secretName) => !routeReferencesSecret(routes, secretName))
  const remoteSecrets = await dependencies.listSecrets()
  const remoteDeletions = deletable.filter((secretName) => remoteSecrets.has(secretName))
  if (remoteDeletions.length > 0) await dependencies.deleteSecrets(remoteDeletions)

  let nextDevVarsText = devVarsText
  let localChanged = false
  for (const secretName of deletable) {
    if (getDevVar(nextDevVarsText, secretName) !== null) {
      nextDevVarsText = removeDevVar(nextDevVarsText, secretName)
      localChanged = true
    }
  }
  if (localChanged) await dependencies.writePrivateText(devVarsPath, nextDevVarsText)
  for (const secretName of archive.secrets.map((secret) => secret.name).filter((secretName) => !deletable.includes(secretName))) {
    dependencies.log(`Retained shared subscription secret ${secretName}`)
  }
  for (const secretName of archive.unavailableSecretNames) {
    dependencies.log(`Retained unrecoverable subscription secret ${secretName}`)
  }
  const updated = updateArchive(manifest, name, { secretsRemoved: true })
  await persistManifest(manifestPath, updated, dependencies)
  return updated
}

async function finalizeSubscriptionRetirement(
  options: SubscriptionRetirementOptions,
  paths: { routes: string; manifest: string; devVars: string },
  dependencies: SubscriptionRetirementDependencies,
): Promise<'finalized' | 'cancelled' | 'complete'> {
  const [routesText, manifestText, devVarsText, remote] = await Promise.all([
    dependencies.readText(paths.routes),
    dependencies.readPrivateText(paths.manifest),
    dependencies.readPrivateText(paths.devVars),
    dependencies.readKv(),
  ])
  let manifest = parseRetirementManifest(manifestText)
  const routes = parseRoutes(routesText)
  const local = localSubscription(routes, options.name)
  const archived = manifest.subscriptions[options.name]
  const subscription = local ?? archived?.subscription
  if (!subscription) throw new Error(`subscription does not exist and is not archived: ${options.name}`)
  if (local?.enabled) throw new Error(`subscription ${options.name} must be disabled locally before finalization`)
  if (archived?.kvRemoved && archived.secretsRemoved && (!archived.hook || archived.hook.deleted)) {
    dependencies.log(`Subscription retirement is already complete: ${options.name}`)
    return 'complete'
  }
  assertRemoteDisabled(subscription, remote, archived)

  if (!archived) {
    manifest = archiveSubscription(
      manifest,
      subscription,
      captureSecretValues(subscriptionSecretNames(subscription), devVarsText),
    )
  }
  let archive = manifest.subscriptions[options.name]!
  const hook = await plannedGitHubHook(subscription, archive, dependencies)
  if (hook && !archive.hook) {
    manifest = updateArchive(manifest, options.name, { hook })
    archive = manifest.subscriptions[options.name]!
  }
  await persistManifest(paths.manifest, manifest, dependencies)

  let finalRoutesText = routesText
  if (local) {
    finalRoutesText = removeSubscription(routesText, options.name).routesText
    await dependencies.writeText(paths.routes, finalRoutesText)
    manifest = updateArchive(manifest, options.name, { localRemoved: true })
    await persistManifest(paths.manifest, manifest, dependencies)
  } else if (!manifest.subscriptions[options.name]!.localRemoved) {
    manifest = updateArchive(manifest, options.name, { localRemoved: true })
    await persistManifest(paths.manifest, manifest, dependencies)
  }
  await dependencies.runSync(false)
  if (!options.yes && !(await dependencies.confirm(`Finalize subscription retirement for ${options.name}?`))) {
    dependencies.log('Finalization cancelled; the disabled production route and recovery archive were retained')
    return 'cancelled'
  }

  manifest = await deletePlannedHook(manifest, options.name, subscription, paths.manifest, dependencies)
  await dependencies.runSync(true)
  const verified = await dependencies.readKv()
  if (verified.subs[subscriptionKvKey(subscription.slugHash)] !== undefined) {
    throw new Error(`subscription ${options.name} still exists in production KV after sync`)
  }
  manifest = updateArchive(manifest, options.name, { kvRemoved: true })
  await persistManifest(paths.manifest, manifest, dependencies)
  manifest = await cleanupSubscriptionSecrets(
    manifest,
    options.name,
    parseRoutes(finalRoutesText),
    devVarsText,
    paths.devVars,
    paths.manifest,
    dependencies,
  )
  dependencies.log(`Finalized subscription retirement for ${options.name}`)
  return 'finalized'
}

export async function runSubscriptionRetirement(
  options: SubscriptionRetirementOptions,
  dependencies: SubscriptionRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<'prepared' | 'applied' | 'finalized' | 'cancelled' | 'complete'> {
  const paths = {
    routes: resolve(projectRoot, ROUTES_FILE),
    devVars: resolve(projectRoot, DEV_VARS_FILE),
    manifest: resolve(projectRoot, options.manifest),
  }
  if (options.finalize) return finalizeSubscriptionRetirement(options, paths, dependencies)
  return prepareSubscriptionRetirement(options, paths, dependencies)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(subscriptionRetirementUsage())
    return
  }
  await runSubscriptionRetirement(parseSubscriptionRetirementArgs(argv))
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
