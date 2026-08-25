import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { planEventDeliveries } from '../../../src/ingest'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import { subscriptionKvKey } from '../../../src/lib/subscription'
import type { NormalizedEvent } from '../../../src/types'
import { putRemoteKv, readRemoteKvSnapshot, type RemoteKvSnapshot } from '../../../scripts/kv'
import {
  confirm,
  getDevVar,
  listWranglerSecrets,
  privateFileIssue,
  putWranglerSecretsBulk,
  readPrivateOptionalText,
  runProcess,
  setDevVar,
  writePrivateText,
  writeText,
  type SecretValue,
} from '../../../scripts/setup'
import { computePlan, parseRoutes, type Routes, type Sub } from '../../../scripts/sync'
import {
  parseManagedSubscriptionManifest,
  type ManagedSubscriptionManifest,
  type ManagedSubscriptionManifestEntry,
} from './manifest'
import {
  MANAGED_SUBSCRIPTION_VERIFICATION_TYPE,
  buildManagedSubscription,
  managedSubscriptionUrl,
} from './model'
import { managedRouteIdentityIssues, managedRouteMatches, updateManagedRoutes } from './routes'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const VERIFICATION_SOURCE = 'urn:hookrelay:subscription-fleet'
const SUCCESS_STATUS = 200

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type ProgressReporter = (message: string) => void

export type ManagedSubscriptionPhase = 'plan' | 'prepare' | 'apply' | 'verify'

export interface ManagedSubscriptionOptions {
  phase: ManagedSubscriptionPhase
  manifest: string
  subscriptions: string[]
  yes: boolean
  progress?: ProgressReporter
}

export interface SenderSecretAddition {
  subscription: string
  configPath: string
  names: string[]
}

export interface ManagedSubscriptionPlan {
  selected: string[]
  blockers: string[]
  routeAdditions: string[]
  routeUpdates: string[]
  localSecretAdditions: string[]
  receiverSecretAdditions: string[]
  senderSecretAdditions: SenderSecretAddition[]
  remoteSubscriptionUpdates: number
  remoteSinkUpdates: number
}

export interface ManagedSubscriptionPrepareResult {
  subscriptions: string[]
  routeAdditions: number
  routeUpdates: number
  localSecretAdditions: number
}

export interface ManagedSubscriptionApplyResult {
  applied: boolean
  receiverSecretsInstalled: number
  senderSecretsInstalled: number
  subscriptionRoutesWritten: number
  sinkRoutesWritten: number
}

export interface ManagedSubscriptionVerifyResult {
  subscriptions: string[]
  verifiedRequests: number
  issues: string[]
}

export interface ManagedSubscriptionDependencies {
  readText(path: string): Promise<string>
  readPrivateText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  writePrivateText(path: string, text: string): Promise<void>
  fileIssue(path: string): Promise<string | null>
  listReceiverSecrets(): Promise<Set<string>>
  putReceiverSecrets(secrets: readonly SecretValue[]): Promise<Set<string>>
  listSenderSecrets(configPath: string): Promise<Set<string>>
  putSenderSecrets(configPath: string, secrets: readonly SecretValue[]): Promise<Set<string>>
  readKv(progress?: ProgressReporter): Promise<RemoteKvSnapshot>
  putKv(binding: string, key: string, value: string): Promise<void>
  confirm(question: string): Promise<boolean>
  fetch: Fetcher
}

async function listConfigSecrets(configPath: string): Promise<Set<string>> {
  const output = await runProcess(
    'npx',
    ['wrangler', 'secret', 'list', '--config', configPath],
    { captureStdout: true },
  )
  const parsed = JSON.parse(output) as Array<{ name: string }>
  return new Set(parsed.map((entry) => entry.name))
}

async function putConfigSecrets(
  configPath: string,
  secrets: readonly SecretValue[],
): Promise<Set<string>> {
  if (secrets.length === 0) return listConfigSecrets(configPath)
  const values = Object.fromEntries(secrets.map((secret) => [secret.name, secret.value]))
  await runProcess(
    'npx',
    ['wrangler', 'secret', 'bulk', '--config', configPath],
    { input: `${JSON.stringify(values)}\n` },
  )
  const installed = await listConfigSecrets(configPath)
  for (const secret of secrets) {
    if (!installed.has(secret.name)) throw new Error(`sender Worker secret was not installed: ${secret.name}`)
  }
  return installed
}

const DEFAULT_DEPENDENCIES: ManagedSubscriptionDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  readPrivateText: readPrivateOptionalText,
  writeText,
  writePrivateText,
  fileIssue: privateFileIssue,
  listReceiverSecrets: listWranglerSecrets,
  putReceiverSecrets: putWranglerSecretsBulk,
  listSenderSecrets: listConfigSecrets,
  putSenderSecrets: putConfigSecrets,
  readKv: (progress) => readRemoteKvSnapshot(undefined, progress),
  putKv: putRemoteKv,
  confirm,
  fetch,
}

interface ManagedSubscriptionFiles {
  routesText: string
  routes: Routes
  devVarsText: string
  manifest: ManagedSubscriptionManifest
}

interface ManagedSubscriptionPaths {
  routes: string
  devVars: string
  manifest: string
}

function managedSubscriptionPaths(options: ManagedSubscriptionOptions, projectRoot: string): ManagedSubscriptionPaths {
  return {
    routes: resolve(projectRoot, ROUTES_FILE),
    devVars: resolve(projectRoot, DEV_VARS_FILE),
    manifest: resolve(projectRoot, options.manifest),
  }
}

async function readManagedSubscriptionFiles(
  options: ManagedSubscriptionOptions,
  projectRoot: string,
  dependencies: ManagedSubscriptionDependencies,
): Promise<ManagedSubscriptionFiles> {
  const paths = managedSubscriptionPaths(options, projectRoot)
  const [manifestIssue, devVarsIssue] = await Promise.all([
    dependencies.fileIssue(paths.manifest),
    dependencies.fileIssue(paths.devVars),
  ])
  const issues = [manifestIssue, devVarsIssue].filter((issue): issue is string => issue !== null)
  if (issues.length > 0) throw new Error(issues.join('\n'))
  const [routesText, devVarsText, manifestText] = await Promise.all([
    dependencies.readText(paths.routes),
    dependencies.readPrivateText(paths.devVars),
    dependencies.readPrivateText(paths.manifest),
  ])
  return {
    routesText,
    routes: parseRoutes(routesText),
    devVarsText,
    manifest: parseManagedSubscriptionManifest(manifestText),
  }
}

function selectedEntries(
  manifest: ManagedSubscriptionManifest,
  selectedNames: readonly string[],
): Array<[string, ManagedSubscriptionManifestEntry]> {
  if (selectedNames.length === 0) throw new Error('at least one managed subscription selection is required')
  if (new Set(selectedNames).size !== selectedNames.length) {
    throw new Error('managed subscription selected more than once')
  }
  return [...selectedNames].sort().map((name) => {
    const entry = manifest.subscriptions[name]
    if (!entry) throw new Error(`managed subscription is not in the manifest: ${name}`)
    return [name, entry]
  })
}

async function desiredRoutes(
  entries: ReadonlyArray<[string, ManagedSubscriptionManifestEntry]>,
): Promise<Map<string, Sub>> {
  return new Map(await Promise.all(entries.map(async ([name, entry]) => [
    name,
    await buildManagedSubscription(name, entry),
  ] as const)))
}

function namedLocalRoute(routes: Routes, name: string): Sub | undefined {
  const matches = routes.subs.filter((subscription) => subscription.name === name)
  if (matches.length > 1) throw new Error(`subscription is declared more than once: ${name}`)
  return matches[0]
}

function requiredSinkSecretNames(routes: Routes, sinkNames: ReadonlySet<string>): string[] {
  return routes.sinks
    .filter((sink) => sinkNames.has(sink.name))
    .flatMap((sink) => Object.entries(sink)
      .filter(([field, value]) => field.endsWith('Env') && typeof value === 'string')
      .map(([, value]) => value as string))
}

function verificationEvent(name: string): NormalizedEvent {
  return {
    source: 'cloudevents',
    subName: name,
    type: MANAGED_SUBSCRIPTION_VERIFICATION_TYPE,
    id: 'managed-subscription-verification',
    timestamp: '2000-01-01T00:00:00.000Z',
    title: 'Managed subscription verification',
    body: '',
    severity: 'debug',
    raw: {},
  }
}

function verificationWouldDeliver(name: string, route: Sub): boolean {
  return planEventDeliveries(verificationEvent(name), route).deliveries.some((delivery) => delivery.deliver)
}

function remoteRouteNameCollisions(
  remote: RemoteKvSnapshot,
  expected: ReadonlyMap<string, Sub>,
): string[] {
  const expectedKeys = new Map([...expected].map(([name, route]) => [name, subscriptionKvKey(route.slugHash)]))
  const expectedNames = new Set(expected.keys())
  const expectedSecretOwners = new Map([...expected].map(([name, route]) => [route.auth!.secretEnv, name]))
  const issues: string[] = []
  for (const [key, value] of Object.entries(remote.subs)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      const selected = [...expectedKeys].find(([, expectedKey]) => expectedKey === key)
      if (selected) issues.push(`${selected[0]}: production route at the selected slug hash is invalid`)
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const route = parsed as Record<string, unknown>
    const name = route.name
    const expectedName = [...expectedKeys].find(([, expectedKey]) => expectedKey === key)?.[0]
    if (expectedName && name !== expectedName) {
      issues.push(`${expectedName}: production slug hash is owned by another route`)
    }
    if (typeof name === 'string' && expectedKeys.has(name) && key !== expectedKeys.get(name)) {
      issues.push(`${name}: production has a route under a different slug hash`)
    }
    if (
      typeof name === 'string'
      && !expectedNames.has(name)
      && route.auth
      && typeof route.auth === 'object'
      && !Array.isArray(route.auth)
    ) {
      const auth = route.auth as Record<string, unknown>
      const secretNames = [
        ...(typeof auth.secretEnv === 'string' ? [auth.secretEnv] : []),
        ...(Array.isArray(auth.alternateSecretEnvs)
          ? auth.alternateSecretEnvs.filter((value): value is string => typeof value === 'string')
          : []),
      ]
      for (const secretName of secretNames) {
        const owner = expectedSecretOwners.get(secretName)
        if (owner) issues.push(`${owner}: production HMAC reference is used by another route`)
      }
    }
  }
  return issues
}

function selectedPlanUpdates(
  routes: Routes,
  remote: RemoteKvSnapshot,
  expected: ReadonlyMap<string, Sub>,
  sinkNames: ReadonlySet<string>,
): { subscriptions: number; sinks: number } {
  const plan = computePlan(routes, remote)
  const subscriptionKeys = new Set([...expected.values()].map((route) => subscriptionKvKey(route.slugHash)))
  const sinkKeys = new Set([...sinkNames].map((name) => `sink:${name}`))
  return {
    subscriptions: plan.subPuts.filter((put) => subscriptionKeys.has(put.key)).length,
    sinks: plan.sinkPuts.filter((put) => sinkKeys.has(put.key)).length,
  }
}

export async function planManagedSubscriptions(
  options: ManagedSubscriptionOptions,
  dependencies: ManagedSubscriptionDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<ManagedSubscriptionPlan> {
  const files = await readManagedSubscriptionFiles(options, projectRoot, dependencies)
  const entries = selectedEntries(files.manifest, options.subscriptions)
  const expected = await desiredRoutes(entries)
  const selected = entries.map(([name]) => name)
  const blockers: string[] = []
  const routeAdditions: string[] = []
  const routeUpdates: string[] = []
  const localSecretAdditions: string[] = []
  const sinkNames = new Set(entries.flatMap(([, entry]) => entry.sinks))
  const invalidSenderConfigs = new Set<string>()

  try {
    managedSubscriptionUrl(files.routes.baseUrl ?? '', entries[0]![1])
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error))
  }

  for (const sinkName of sinkNames) {
    if (!files.routes.sinks.some((sink) => sink.name === sinkName)) blockers.push(`required sink is missing: ${sinkName}`)
  }
  for (const [name, entry] of entries) {
    const desired = expected.get(name)!
    const existing = namedLocalRoute(files.routes, name)
    if (!existing) routeAdditions.push(name)
    else {
      const identityIssues = managedRouteIdentityIssues(existing, desired)
      if (identityIssues.length > 0) blockers.push(`${name}: route identity differs (${identityIssues.join(', ')})`)
      else if (!managedRouteMatches(existing, desired)) routeUpdates.push(name)
    }
    const localHmac = getDevVar(files.devVarsText, entry.recovery.hmac.name)
    if (localHmac === null) localSecretAdditions.push(entry.recovery.hmac.name)
    else if (localHmac !== entry.recovery.hmac.value) blockers.push(`${name}: local HMAC differs from recovery`)
    if (verificationWouldDeliver(name, desired)) {
      blockers.push(`${name}: filters would deliver the managed verification event to a sink`)
    }
    if (entry.sender) {
      const issue = await dependencies.fileIssue(entry.sender.configPath)
      if (issue) {
        blockers.push(issue)
        invalidSenderConfigs.add(entry.sender.configPath)
      }
    }
  }

  try {
    updateManagedRoutes(files.routesText, files.routes.subs, expected)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!blockers.includes(message)) blockers.push(message)
  }

  options.progress?.('Reading Hookrelay Worker secrets and production routes')
  const [receiverSecrets, remote] = await Promise.all([
    dependencies.listReceiverSecrets(),
    dependencies.readKv(options.progress),
  ])
  for (const name of requiredSinkSecretNames(files.routes, sinkNames)) {
    if (!receiverSecrets.has(name)) blockers.push(`required sink references missing Wrangler secret ${name}`)
  }
  const receiverSecretAdditions = entries
    .map(([, entry]) => entry.recovery.hmac.name)
    .filter((name) => !receiverSecrets.has(name))

  const senderSecretAdditions: SenderSecretAddition[] = []
  const senderSecretCache = new Map<string, Set<string>>()
  for (const [name, entry] of entries) {
    if (!entry.sender || invalidSenderConfigs.has(entry.sender.configPath)) continue
    let senderSecrets = senderSecretCache.get(entry.sender.configPath)
    if (!senderSecrets) {
      try {
        senderSecrets = await dependencies.listSenderSecrets(entry.sender.configPath)
        senderSecretCache.set(entry.sender.configPath, senderSecrets)
      } catch (error) {
        blockers.push(`${name}: sender Worker secret inventory failed (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
    }
    const names = [entry.sender.urlSecretName, entry.sender.hmacSecretName]
      .filter((secretName) => !senderSecrets!.has(secretName))
    if (names.length > 0) senderSecretAdditions.push({
      subscription: name,
      configPath: entry.sender.configPath,
      names,
    })
  }

  blockers.push(...remoteRouteNameCollisions(remote, expected))
  let projectedRoutes = files.routes
  try {
    const projectedText = updateManagedRoutes(files.routesText, files.routes.subs, expected).routesText
    projectedRoutes = parseRoutes(projectedText)
  } catch {}
  const remoteUpdates = selectedPlanUpdates(projectedRoutes, remote, expected, sinkNames)

  return {
    selected,
    blockers: [...new Set(blockers)].sort(),
    routeAdditions,
    routeUpdates,
    localSecretAdditions,
    receiverSecretAdditions,
    senderSecretAdditions,
    remoteSubscriptionUpdates: remoteUpdates.subscriptions,
    remoteSinkUpdates: remoteUpdates.sinks,
  }
}

function formatItems(label: string, items: readonly string[]): string {
  return `${label}: ${items.length === 0 ? 'none' : items.join(', ')}`
}

export function formatManagedSubscriptionPlan(plan: ManagedSubscriptionPlan): string {
  const sender = plan.senderSecretAdditions.flatMap((addition) => (
    addition.names.map((name) => `${addition.subscription}:${name}`)
  ))
  return [
    formatItems('Managed subscriptions', plan.selected),
    formatItems('Local route additions', plan.routeAdditions),
    formatItems('Local route updates', plan.routeUpdates),
    formatItems('Local HMAC additions', plan.localSecretAdditions),
    formatItems('Hookrelay Worker secret additions', plan.receiverSecretAdditions),
    formatItems('Sender Worker secret additions', sender),
    `Production subscription route updates: ${plan.remoteSubscriptionUpdates}`,
    `Production sink route updates: ${plan.remoteSinkUpdates}`,
    ...(plan.blockers.length > 0
      ? ['Blockers:', ...plan.blockers.map((blocker) => `  - ${blocker}`)]
      : ['Blockers: none']),
  ].join('\n')
}

export async function prepareManagedSubscriptions(
  options: ManagedSubscriptionOptions,
  dependencies: ManagedSubscriptionDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<ManagedSubscriptionPrepareResult> {
  const paths = managedSubscriptionPaths(options, projectRoot)
  const files = await readManagedSubscriptionFiles(options, projectRoot, dependencies)
  const entries = selectedEntries(files.manifest, options.subscriptions)
  const expected = await desiredRoutes(entries)
  const sinkNames = new Set(entries.flatMap(([, entry]) => entry.sinks))
  if (entries.length > 0) managedSubscriptionUrl(files.routes.baseUrl ?? '', entries[0]![1])
  for (const sinkName of sinkNames) {
    if (!files.routes.sinks.some((sink) => sink.name === sinkName)) throw new Error(`required sink is missing: ${sinkName}`)
  }
  for (const [name, entry] of entries) {
    if (verificationWouldDeliver(name, expected.get(name)!)) {
      throw new Error(`${name}: filters would deliver the managed verification event to a sink`)
    }
    if (entry.sender) {
      const issue = await dependencies.fileIssue(entry.sender.configPath)
      if (issue) throw new Error(issue)
    }
  }

  const routeUpdate = updateManagedRoutes(files.routesText, files.routes.subs, expected)
  let devVarsText = files.devVarsText
  let localSecretAdditions = 0
  for (const [name, entry] of entries) {
    const existing = getDevVar(devVarsText, entry.recovery.hmac.name)
    if (existing !== null && existing !== entry.recovery.hmac.value) {
      throw new Error(`${name}: local HMAC differs from recovery`)
    }
    if (existing === null) {
      devVarsText = setDevVar(devVarsText, entry.recovery.hmac.name, entry.recovery.hmac.value)
      localSecretAdditions += 1
    }
  }

  if (routeUpdate.routesText !== files.routesText) await dependencies.writeText(paths.routes, routeUpdate.routesText)
  if (devVarsText !== files.devVarsText) await dependencies.writePrivateText(paths.devVars, devVarsText)
  return {
    subscriptions: entries.map(([name]) => name),
    routeAdditions: routeUpdate.additions.length,
    routeUpdates: routeUpdate.updates.length,
    localSecretAdditions,
  }
}

function assertPlanReadyForApply(plan: ManagedSubscriptionPlan): void {
  if (plan.blockers.length > 0) throw new Error(`managed subscription plan has blockers\n${plan.blockers.join('\n')}`)
  const localChanges = plan.routeAdditions.length + plan.routeUpdates.length + plan.localSecretAdditions.length
  if (localChanges > 0) throw new Error('managed subscriptions are not prepared locally; run the prepare phase')
}

function selectedRouteAndSinkPuts(
  routes: Routes,
  remote: RemoteKvSnapshot,
  expected: ReadonlyMap<string, Sub>,
  sinkNames: ReadonlySet<string>,
) {
  const plan = computePlan(routes, remote)
  const subscriptionKeys = new Set([...expected.values()].map((route) => subscriptionKvKey(route.slugHash)))
  const sinkKeys = new Set([...sinkNames].map((name) => `sink:${name}`))
  return {
    subscriptions: plan.subPuts.filter((put) => subscriptionKeys.has(put.key)),
    sinks: plan.sinkPuts.filter((put) => sinkKeys.has(put.key)),
  }
}

export async function applyManagedSubscriptions(
  options: ManagedSubscriptionOptions,
  dependencies: ManagedSubscriptionDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<ManagedSubscriptionApplyResult> {
  const plan = await planManagedSubscriptions(options, dependencies, projectRoot)
  assertPlanReadyForApply(plan)
  if (!options.yes && !(await dependencies.confirm(`Apply ${plan.selected.length} managed Hookrelay subscription(s)?`))) {
    return {
      applied: false,
      receiverSecretsInstalled: 0,
      senderSecretsInstalled: 0,
      subscriptionRoutesWritten: 0,
      sinkRoutesWritten: 0,
    }
  }

  const files = await readManagedSubscriptionFiles(options, projectRoot, dependencies)
  const entries = selectedEntries(files.manifest, options.subscriptions)
  const expected = await desiredRoutes(entries)
  const sinkNames = new Set(entries.flatMap(([, entry]) => entry.sinks))
  const receiverSecrets = await dependencies.listReceiverSecrets()
  const receiverAdditions = entries
    .map(([, entry]) => entry.recovery.hmac)
    .filter((secret) => !receiverSecrets.has(secret.name))
  if (receiverAdditions.length > 0) await dependencies.putReceiverSecrets(receiverAdditions)

  let senderSecretsInstalled = 0
  const senderGroups = new Map<string, SecretValue[]>()
  for (const [, entry] of entries) {
    if (!entry.sender) continue
    const existing = await dependencies.listSenderSecrets(entry.sender.configPath)
    const additions: SecretValue[] = []
    if (!existing.has(entry.sender.urlSecretName)) additions.push({
      name: entry.sender.urlSecretName,
      value: managedSubscriptionUrl(files.routes.baseUrl ?? '', entry),
    })
    if (!existing.has(entry.sender.hmacSecretName)) additions.push({
      name: entry.sender.hmacSecretName,
      value: entry.recovery.hmac.value,
    })
    const group = senderGroups.get(entry.sender.configPath) ?? []
    for (const addition of additions) {
      const conflict = group.find((secret) => secret.name === addition.name && secret.value !== addition.value)
      if (conflict) throw new Error(`sender Worker secret has conflicting managed values: ${addition.name}`)
      if (!group.some((secret) => secret.name === addition.name)) group.push(addition)
    }
    senderGroups.set(entry.sender.configPath, group)
  }
  for (const [configPath, secrets] of senderGroups) {
    if (secrets.length === 0) continue
    await dependencies.putSenderSecrets(configPath, secrets)
    senderSecretsInstalled += secrets.length
  }

  const remote = await dependencies.readKv(options.progress)
  const puts = selectedRouteAndSinkPuts(files.routes, remote, expected, sinkNames)
  for (const put of puts.subscriptions) await dependencies.putKv('SUBS', put.key, put.value)
  for (const put of puts.sinks) await dependencies.putKv('SINKS', put.key, put.value)

  const remaining = selectedRouteAndSinkPuts(
    files.routes,
    await dependencies.readKv(options.progress),
    expected,
    sinkNames,
  )
  if (remaining.subscriptions.length > 0 || remaining.sinks.length > 0) {
    throw new Error('production KV did not retain all managed subscription updates')
  }
  return {
    applied: true,
    receiverSecretsInstalled: receiverAdditions.length,
    senderSecretsInstalled,
    subscriptionRoutesWritten: puts.subscriptions.length,
    sinkRoutesWritten: puts.sinks.length,
  }
}

function planIssues(plan: ManagedSubscriptionPlan): string[] {
  const issues = [...plan.blockers]
  if (plan.routeAdditions.length > 0) issues.push(`local routes are missing: ${plan.routeAdditions.join(', ')}`)
  if (plan.routeUpdates.length > 0) issues.push(`local routes need updates: ${plan.routeUpdates.join(', ')}`)
  if (plan.localSecretAdditions.length > 0) issues.push(`local HMACs are missing: ${plan.localSecretAdditions.join(', ')}`)
  if (plan.receiverSecretAdditions.length > 0) {
    issues.push(`Hookrelay Worker secrets are missing: ${plan.receiverSecretAdditions.join(', ')}`)
  }
  if (plan.senderSecretAdditions.length > 0) {
    issues.push('sender Worker secrets are missing')
  }
  if (plan.remoteSubscriptionUpdates > 0) issues.push('production subscription routes differ')
  if (plan.remoteSinkUpdates > 0) issues.push('production sink routes differ')
  return issues
}

export async function verifyManagedSubscriptions(
  options: ManagedSubscriptionOptions,
  dependencies: ManagedSubscriptionDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<ManagedSubscriptionVerifyResult> {
  const plan = await planManagedSubscriptions(options, dependencies, projectRoot)
  const issues = planIssues(plan)
  if (issues.length > 0) return { subscriptions: plan.selected, verifiedRequests: 0, issues }
  const files = await readManagedSubscriptionFiles(options, projectRoot, dependencies)
  const entries = selectedEntries(files.manifest, options.subscriptions)
  let verifiedRequests = 0

  for (const [name, entry] of entries) {
    const body = JSON.stringify({
      specversion: '1.0',
      id: randomUUID(),
      source: VERIFICATION_SOURCE,
      type: MANAGED_SUBSCRIPTION_VERIFICATION_TYPE,
      title: 'Managed subscription verification',
      severity: 'debug',
      data: { subscription: name },
    })
    const signature = await hmacSha256Hex(entry.recovery.hmac.value, new TextEncoder().encode(body))
    let response: Response
    try {
      response = await dependencies.fetch(managedSubscriptionUrl(files.routes.baseUrl ?? '', entry), {
        method: 'POST',
        headers: {
          'content-type': 'application/cloudevents+json',
          'x-hookrelay-signature-256': `sha256=${signature}`,
        },
        body,
        redirect: 'manual',
      })
    } catch {
      issues.push(`${name}: authenticated verification request failed`)
      continue
    }
    if (response.status !== SUCCESS_STATUS) {
      issues.push(`${name}: authenticated verification returned HTTP ${response.status}`)
      continue
    }
    verifiedRequests += 1
  }
  return { subscriptions: plan.selected, verifiedRequests, issues }
}
