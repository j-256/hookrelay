import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { readRemoteKvSnapshot, type RemoteKvSnapshot } from './kv'
import {
  archiveSink,
  captureSecretValues,
  parseRetirementManifest,
  routeReferencesSecret,
  serializeRetirementManifest,
  sinkSecretNames,
  type RetirementManifest,
  type SinkRetirementArchive,
} from './retirement-manifest'
import { removeRetiredSink, retireSink } from './retirement-routes'
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
import { parseRoutes, type Routes, type SinkRef } from './sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const WRANGLER_FILE = 'wrangler.jsonc'
const ACTIVE_DELIVERY_STATUSES = Object.freeze(['pending', 'queued', 'processing', 'retrying', 'exhausted'])

export interface SinkRetirementOptions {
  name: string
  manifest: string
  finalize: boolean
  yes: boolean
}

export interface SinkRetirementDependencies {
  readText(path: string): Promise<string>
  readPrivateText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
  writePrivateText(path: string, text: string): Promise<void>
  readKv(): Promise<RemoteKvSnapshot>
  runSync(apply: boolean): Promise<void>
  confirm(question: string): Promise<boolean>
  countActiveDeliveries(wranglerText: string, sinkName: string): Promise<number>
  listSecrets(): Promise<Set<string>>
  deleteSecrets(names: readonly string[]): Promise<Set<string>>
  log(line: string): void
}

interface D1QueryDependencies {
  fetch: typeof fetch
  environment: Record<string, string | undefined>
}

const DEFAULT_D1_DEPENDENCIES: D1QueryDependencies = { fetch, environment: process.env }

const DEFAULT_DEPENDENCIES: SinkRetirementDependencies = {
  readText: (path) => readFile(path, 'utf8'),
  readPrivateText: readPrivateOptionalText,
  writeText,
  writePrivateText,
  readKv: readRemoteKvSnapshot,
  runSync,
  confirm,
  countActiveDeliveries: (wranglerText, sinkName) => countActiveSinkDeliveries(wranglerText, sinkName),
  listSecrets: listWranglerSecrets,
  deleteSecrets: deleteWranglerSecretsBulk,
  log: console.log,
}

export function sinkRetirementUsage(): string {
  return [
    'usage: pnpm sink:retire <name> --manifest <file> [--finalize] [-y]',
    '',
    'phases:',
    '  default     Move an unused active sink to retiredSinks and verify KV',
    '  --finalize  Require no delivery references, remove KV, and clean safe secrets',
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

export function parseSinkRetirementArgs(argv: string[]): SinkRetirementOptions {
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
    else if (argument === '-h' || argument === '--help') throw new Error(sinkRetirementUsage())
    else if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    else if (name === undefined) name = argument
    else throw new Error(sinkRetirementUsage())
  }
  if (!name || !manifest) throw new Error(sinkRetirementUsage())
  return { name, manifest, finalize, yes }
}

function parseJsoncObject(text: string, label: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not valid JSONC`)
  }
  return value as Record<string, unknown>
}

export function d1DatabaseId(wranglerText: string): string {
  const wrangler = parseJsoncObject(wranglerText, 'wrangler.jsonc')
  const databases = wrangler.d1_databases
  if (!Array.isArray(databases)) throw new Error('wrangler.jsonc has no d1_databases array')
  const matches = databases.filter((value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).binding === 'EVENTS_DB'
  )) as Record<string, unknown>[]
  if (matches.length !== 1 || typeof matches[0]?.database_id !== 'string' || !matches[0].database_id) {
    throw new Error('wrangler.jsonc must declare exactly one EVENTS_DB database_id')
  }
  return matches[0].database_id
}

export async function countActiveSinkDeliveries(
  wranglerText: string,
  sinkName: string,
  dependencies: D1QueryDependencies = DEFAULT_D1_DEPENDENCIES,
): Promise<number> {
  const accountId = dependencies.environment.CLOUDFLARE_ACCOUNT_ID
  const apiToken = dependencies.environment.CLOUDFLARE_API_TOKEN
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is required')
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required')
  const databaseId = d1DatabaseId(wranglerText)
  const placeholders = ACTIVE_DELIVERY_STATUSES.map(() => '?').join(', ')
  const response = await dependencies.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sql: `SELECT COUNT(*) AS count FROM deliveries WHERE sink_name = ? AND status IN (${placeholders})`,
        params: [sinkName, ...ACTIVE_DELIVERY_STATUSES],
      }),
    },
  )
  if (!response.ok) throw new Error(`Cloudflare D1 query failed with HTTP ${response.status}`)
  const body = await response.json() as {
    success?: boolean
    result?: Array<{ success?: boolean; results?: Array<{ count?: unknown }> }>
  }
  const count = body.result?.[0]?.results?.[0]?.count
  if (body.success !== true || body.result?.[0]?.success !== true || !Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error('Cloudflare D1 query returned an invalid active delivery count')
  }
  return count as number
}

function localRetiredSink(routes: Routes, name: string): SinkRef | undefined {
  const matches = (routes.retiredSinks ?? []).filter((sink) => sink.name === name)
  if (matches.length > 1) throw new Error(`retired sink is declared more than once: ${name}`)
  return matches[0]
}

function updateArchive(
  manifest: RetirementManifest,
  name: string,
  update: Partial<SinkRetirementArchive>,
): RetirementManifest {
  const existing = manifest.sinks[name]
  if (!existing) throw new Error(`sink retirement archive is missing: ${name}`)
  return {
    ...manifest,
    sinks: {
      ...manifest.sinks,
      [name]: { ...existing, ...update },
    },
  }
}

async function persistManifest(
  path: string,
  manifest: RetirementManifest,
  dependencies: SinkRetirementDependencies,
): Promise<void> {
  await dependencies.writePrivateText(path, serializeRetirementManifest(manifest))
}

async function prepareSinkRetirement(
  options: SinkRetirementOptions,
  paths: { routes: string; manifest: string },
  dependencies: SinkRetirementDependencies,
): Promise<'prepared' | 'applied' | 'cancelled' | 'complete'> {
  const [routesText, manifestText] = await Promise.all([
    dependencies.readText(paths.routes),
    dependencies.readPrivateText(paths.manifest),
  ])
  const manifest = parseRetirementManifest(manifestText)
  const routes = parseRoutes(routesText)
  const active = routes.sinks.some((sink) => sink.name === options.name)
  const retired = localRetiredSink(routes, options.name)
  if (!active && !retired) {
    const archive = manifest.sinks[options.name]
    if (archive?.kvRemoved && archive.secretsRemoved) {
      dependencies.log(`Sink retirement is already complete: ${options.name}`)
      return 'complete'
    }
    if (archive?.localRemoved) {
      throw new Error(`sink ${options.name} finalization is in progress; rerun with --finalize`)
    }
    throw new Error(`sink does not exist: ${options.name}`)
  }
  const result = retireSink(routesText, options.name)
  await persistManifest(paths.manifest, manifest, dependencies)
  if (result.changed) await dependencies.writeText(paths.routes, result.routesText)
  dependencies.log(`${result.changed ? 'Staged' : 'Already staged'} sink retirement for ${options.name}`)
  await dependencies.runSync(false)
  if (!options.yes && !(await dependencies.confirm(`Apply the staged sink ${options.name} state to production KV?`))) {
    dependencies.log('Production KV was not changed')
    return 'cancelled'
  }
  await dependencies.runSync(true)
  dependencies.log(`Verified staged sink ${options.name} in production KV`)
  return options.yes ? 'applied' : 'prepared'
}

async function cleanupSinkSecrets(
  manifest: RetirementManifest,
  name: string,
  routes: Routes,
  devVarsText: string,
  devVarsPath: string,
  manifestPath: string,
  dependencies: SinkRetirementDependencies,
): Promise<RetirementManifest> {
  const archive = manifest.sinks[name]!
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
    dependencies.log(`Retained shared sink secret ${secretName}`)
  }
  for (const secretName of archive.unavailableSecretNames) {
    dependencies.log(`Retained unrecoverable sink secret ${secretName}`)
  }
  const updated = updateArchive(manifest, name, { secretsRemoved: true })
  await persistManifest(manifestPath, updated, dependencies)
  return updated
}

async function finalizeSinkRetirement(
  options: SinkRetirementOptions,
  paths: { routes: string; manifest: string; devVars: string; wrangler: string },
  dependencies: SinkRetirementDependencies,
): Promise<'finalized' | 'cancelled' | 'complete'> {
  const [routesText, manifestText, devVarsText, wranglerText, remote] = await Promise.all([
    dependencies.readText(paths.routes),
    dependencies.readPrivateText(paths.manifest),
    dependencies.readPrivateText(paths.devVars),
    dependencies.readText(paths.wrangler),
    dependencies.readKv(),
  ])
  let manifest = parseRetirementManifest(manifestText)
  const routes = parseRoutes(routesText)
  const local = localRetiredSink(routes, options.name)
  const archived = manifest.sinks[options.name]
  const sink = local ?? archived?.sink
  if (!sink) throw new Error(`retired sink does not exist and is not archived: ${options.name}`)
  if (routes.sinks.some((candidate) => candidate.name === options.name)) {
    throw new Error(`sink ${options.name} must be staged in retiredSinks before finalization`)
  }
  if (archived?.kvRemoved && archived.secretsRemoved) {
    dependencies.log(`Sink retirement is already complete: ${options.name}`)
    return 'complete'
  }
  if (local && remote.sinks[`sink:${options.name}`] === undefined) {
    throw new Error(`sink ${options.name} is not present in production KV; apply the staged phase first`)
  }
  const references = routes.subs.filter((subscription) => subscription.sinks.includes(options.name))
  if (references.length > 0) {
    throw new Error(`sink ${options.name} is still referenced by subscriptions: ${references.map((sub) => sub.name).sort().join(', ')}`)
  }
  const activeDeliveries = await dependencies.countActiveDeliveries(wranglerText, options.name)
  if (activeDeliveries > 0) {
    throw new Error(`sink ${options.name} still has ${activeDeliveries} active or failed delivery rows`)
  }

  if (!archived) {
    manifest = archiveSink(manifest, sink, captureSecretValues(sinkSecretNames(sink), devVarsText))
  }
  await persistManifest(paths.manifest, manifest, dependencies)
  let finalRoutesText = routesText
  if (local) {
    finalRoutesText = removeRetiredSink(routesText, options.name).routesText
    await dependencies.writeText(paths.routes, finalRoutesText)
    manifest = updateArchive(manifest, options.name, { localRemoved: true })
    await persistManifest(paths.manifest, manifest, dependencies)
  } else if (!manifest.sinks[options.name]!.localRemoved) {
    manifest = updateArchive(manifest, options.name, { localRemoved: true })
    await persistManifest(paths.manifest, manifest, dependencies)
  }
  await dependencies.runSync(false)
  if (!options.yes && !(await dependencies.confirm(`Finalize sink retirement for ${options.name}?`))) {
    dependencies.log('Finalization cancelled; production KV and the recovery archive were retained')
    return 'cancelled'
  }
  await dependencies.runSync(true)
  const verified = await dependencies.readKv()
  if (verified.sinks[`sink:${options.name}`] !== undefined) {
    throw new Error(`sink ${options.name} still exists in production KV after sync`)
  }
  manifest = updateArchive(manifest, options.name, { kvRemoved: true })
  await persistManifest(paths.manifest, manifest, dependencies)
  manifest = await cleanupSinkSecrets(
    manifest,
    options.name,
    parseRoutes(finalRoutesText),
    devVarsText,
    paths.devVars,
    paths.manifest,
    dependencies,
  )
  dependencies.log(`Finalized sink retirement for ${options.name}`)
  return 'finalized'
}

export async function runSinkRetirement(
  options: SinkRetirementOptions,
  dependencies: SinkRetirementDependencies = DEFAULT_DEPENDENCIES,
  projectRoot = process.cwd(),
): Promise<'prepared' | 'applied' | 'finalized' | 'cancelled' | 'complete'> {
  const paths = {
    routes: resolve(projectRoot, ROUTES_FILE),
    devVars: resolve(projectRoot, DEV_VARS_FILE),
    wrangler: resolve(projectRoot, WRANGLER_FILE),
    manifest: resolve(projectRoot, options.manifest),
  }
  if (options.finalize) return finalizeSinkRetirement(options, paths, dependencies)
  return prepareSinkRetirement(options, paths, dependencies)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(sinkRetirementUsage())
    return
  }
  await runSinkRetirement(parseSinkRetirementArgs(argv))
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
