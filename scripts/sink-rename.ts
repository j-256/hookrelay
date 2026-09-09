import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  addDevVar,
  confirm,
  deleteWranglerSecret,
  envSegment,
  getDevVar,
  listWranglerSecrets,
  prepareProduction,
  readOptionalText,
  removeDevVar,
  type SecretValue,
  writePrivateText,
  writeText,
} from './setup'
import { parseRoutes, type Routes, type SinkRef } from './sync'
import { subscriptionKvKey } from '../src/lib/subscription'
import {
  applyProviderConfiguration,
  planProviderConfiguration,
  readProviderConfiguration,
  type ProviderConfigurationSnapshot,
} from './provider-configuration'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const PREPARE_PHASE = 'prepare'
const SWITCH_PHASE = 'switch'
const FINALIZE_PHASE = 'finalize'
const ENV_REFERENCE_SUFFIX = 'Env'
const SINK_SECRET_PREFIX = 'SINK_'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

type RenamePhase = typeof PREPARE_PHASE | typeof SWITCH_PHASE | typeof FINALIZE_PHASE

export interface SinkRenameOptions {
  oldName: string
  newName: string
  phase: RenamePhase
  yes: boolean
}

export interface SecretRename extends SecretValue {
  oldName: string
}

export interface PreparedSinkRename {
  routesText: string
  devVarsText: string
  oldSink: SinkRef
  newSink: SinkRef
  secrets: SecretRename[]
}

export interface SwitchedSinkRename {
  routesText: string
  subscriptions: string[]
}

export interface FinalizedSinkRename {
  routesText: string
  devVarsText: string
  secretNames: Array<{ oldName: string; newName: string }>
}

export function sinkRenameUsage(): string {
  return [
    'usage: pnpm sink:rename <old-name> <new-name> [--switch|--finalize] [-y]',
    '',
    'phases:',
    '  default     deploy the new secret and both compatible sink names',
    '  --switch    route subscriptions to the new sink name',
    '  --finalize  delete the obsolete secret while retaining the old sink alias',
    '',
    'options:',
    '  -y, --yes   apply production changes without prompts',
    '  -h, --help  show this help',
  ].join('\n')
}

export function parseSinkRenameArgs(argv: string[]): SinkRenameOptions {
  const positional: string[] = []
  let phase: RenamePhase = PREPARE_PHASE
  let phaseSelected = false
  let yes = false

  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--help' || arg === '-h') throw new Error(sinkRenameUsage())
    else if (arg === '--prepare' || arg === '--switch' || arg === '--finalize') {
      if (phaseSelected) throw new Error('choose only one rename phase')
      phase = arg.slice(2) as RenamePhase
      phaseSelected = true
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else positional.push(arg)
  }

  if (positional.length !== 2) throw new Error(sinkRenameUsage())
  const [oldName, newName] = positional as [string, string]
  if (oldName === newName) throw new Error('old and new sink names must differ')
  envSegment(oldName)
  envSegment(newName)
  return { oldName, newName, phase, yes }
}

function sinkRecord(sink: SinkRef): Record<string, unknown> {
  return sink as Record<string, unknown>
}

function sinkConfig(sink: SinkRef): Record<string, unknown> {
  const { name: _name, ...config } = sinkRecord(sink)
  return config
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
}

function sameSinkConfig(first: SinkRef, second: SinkRef): boolean {
  return canonicalize(sinkConfig(first)) === canonicalize(sinkConfig(second))
}

function optionalNamedSink(routes: Routes, name: string): { sink: SinkRef; index: number } | null {
  const matches = routes.sinks
    .map((sink, index) => ({ sink, index }))
    .filter(({ sink }) => sink.name === name)
  if (matches.length > 1) throw new Error(`sink is declared more than once: ${name}`)
  return matches[0] ?? null
}

function namedSink(routes: Routes, name: string): { sink: SinkRef; index: number } {
  const match = optionalNamedSink(routes, name)
  if (!match) throw new Error(`sink does not exist: ${name}`)
  return match
}

function expectedSecretName(sinkName: string, fieldName: string): string | null {
  if (!fieldName.endsWith(ENV_REFERENCE_SUFFIX)) return null
  const concept = fieldName.slice(0, -ENV_REFERENCE_SUFFIX.length)
  if (!concept) return null
  return `${SINK_SECRET_PREFIX}${envSegment(sinkName)}_${envSegment(concept)}`
}

function conventionSecretRenames(sink: SinkRef, oldName: string, newName: string): Array<{ field: string; oldName: string; newName: string }> {
  const renames: Array<{ field: string; oldName: string; newName: string }> = []
  for (const [field, value] of Object.entries(sinkRecord(sink))) {
    if (typeof value !== 'string') continue
    const oldSecretName = expectedSecretName(oldName, field)
    const newSecretName = expectedSecretName(newName, field)
    if (oldSecretName && newSecretName && value === oldSecretName && oldSecretName !== newSecretName) {
      renames.push({ field, oldName: oldSecretName, newName: newSecretName })
    }
  }
  return renames
}

function routeContainsValue(value: unknown, expected: string): boolean {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some((item) => routeContainsValue(item, expected))
  if (value === null || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some((item) => routeContainsValue(item, expected))
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

export function prepareSinkRename(
  routesText: string,
  devVarsText: string,
  oldName: string,
  newName: string,
): PreparedSinkRename {
  const routes = parseRoutes(routesText)
  const { sink: oldSink, index: oldSinkIndex } = namedSink(routes, oldName)
  if ([...routes.sinks, ...(routes.retiredSinks ?? [])].some((sink) => sink.name === newName)) {
    throw new Error(`sink already exists: ${newName}; use --switch if the rename was already prepared`)
  }

  const secretRenames = conventionSecretRenames(oldSink, oldName, newName)
  let updatedDevVarsText = devVarsText
  const secrets: SecretRename[] = []
  const transformedOldSink = { ...sinkRecord(oldSink) }

  for (const rename of secretRenames) {
    if (routeContainsValue(routes, rename.newName)) {
      throw new Error(`new secret name is already referenced: ${rename.newName}`)
    }
    const value = getDevVar(devVarsText, rename.oldName)
    if (value === null) {
      throw new Error(`${rename.oldName} is missing from .dev.vars; Wrangler cannot return deployed secret values`)
    }
    updatedDevVarsText = addDevVar(updatedDevVarsText, rename.newName, value)
    transformedOldSink[rename.field] = rename.newName
    secrets.push({ oldName: rename.oldName, name: rename.newName, value })
  }

  const newSink = { ...transformedOldSink, name: newName } as SinkRef
  let updatedRoutesText = routesText
  for (const rename of secretRenames) {
    updatedRoutesText = applyEdits(
      updatedRoutesText,
      modify(updatedRoutesText, ['sinks', oldSinkIndex, rename.field], rename.newName, {
        formattingOptions: FORMATTING_OPTIONS,
      }),
    )
  }
  updatedRoutesText = applyEdits(
    updatedRoutesText,
    modify(updatedRoutesText, ['sinks', -1], newSink, {
      isArrayInsertion: true,
      formattingOptions: FORMATTING_OPTIONS,
    }),
  )
  updatedRoutesText = withTrailingNewline(updatedRoutesText)
  const updatedRoutes = parseRoutes(updatedRoutesText)

  return {
    routesText: updatedRoutesText,
    devVarsText: updatedDevVarsText,
    oldSink: namedSink(updatedRoutes, oldName).sink,
    newSink: namedSink(updatedRoutes, newName).sink,
    secrets,
  }
}

export function switchSinkRename(routesText: string, oldName: string, newName: string): SwitchedSinkRename {
  const routes = parseRoutes(routesText)
  const oldSink = namedSink(routes, oldName).sink
  const newSink = namedSink(routes, newName).sink
  if (!sameSinkConfig(oldSink, newSink)) {
    throw new Error(`sink aliases differ: ${oldName} and ${newName}`)
  }
  let updatedRoutesText = routesText
  const subscriptions: string[] = []
  for (let index = 0; index < routes.subs.length; index += 1) {
    const sub = routes.subs[index]!
    if (!sub.sinks.includes(oldName)) continue
    const renamedSinks: string[] = []
    for (const sinkName of sub.sinks) {
      const renamed = sinkName === oldName ? newName : sinkName
      if (!renamedSinks.includes(renamed)) renamedSinks.push(renamed)
    }
    updatedRoutesText = applyEdits(
      updatedRoutesText,
      modify(updatedRoutesText, ['subs', index, 'sinks'], renamedSinks, {
        formattingOptions: FORMATTING_OPTIONS,
      }),
    )
    if (sub.sinkFilters?.[oldName]) {
      const renamedFilters = { ...sub.sinkFilters, [newName]: sub.sinkFilters[oldName] }
      delete renamedFilters[oldName]
      updatedRoutesText = applyEdits(
        updatedRoutesText,
        modify(updatedRoutesText, ['subs', index, 'sinkFilters'], renamedFilters, {
          formattingOptions: FORMATTING_OPTIONS,
        }),
      )
    }
    subscriptions.push(sub.name)
  }

  updatedRoutesText = withTrailingNewline(updatedRoutesText)
  const updatedRoutes = parseRoutes(updatedRoutesText)
  return {
    routesText: updatedRoutesText,
    subscriptions: [...new Set([
      ...subscriptions,
      ...updatedRoutes.subs.filter(sub => sub.sinks.includes(newName)).map(sub => sub.name),
    ])],
  }
}

export function finalizeSinkRename(
  routesText: string,
  devVarsText: string,
  oldName: string,
  newName: string,
  removeLocalAlias = false,
): FinalizedSinkRename {
  const routes = parseRoutes(routesText)
  const oldMatch = optionalNamedSink(routes, oldName)
  if (!oldMatch && !removeLocalAlias) throw new Error(`sink does not exist: ${oldName}`)
  const newSink = namedSink(routes, newName).sink
  if (oldMatch && !sameSinkConfig(oldMatch.sink, newSink)) {
    throw new Error(`sink aliases differ: ${oldName} and ${newName}`)
  }
  const oldSubscriptions = routes.subs.filter((sub) => sub.sinks.includes(oldName))
  if (oldSubscriptions.length > 0) {
    throw new Error(`subscriptions still reference ${oldName}; run the --switch phase first`)
  }

  let updatedDevVarsText = devVarsText
  const secretNames: Array<{ oldName: string; newName: string }> = []
  for (const [field, value] of Object.entries(sinkRecord(newSink))) {
    if (typeof value !== 'string') continue
    const oldSecretName = expectedSecretName(oldName, field)
    const newSecretName = expectedSecretName(newName, field)
    if (!oldSecretName || !newSecretName || value !== newSecretName || oldSecretName === newSecretName) continue
    if (routeContainsValue(routes, oldSecretName)) {
      throw new Error(`cannot delete secret while routes still reference it: ${oldSecretName}`)
    }
    const newValue = getDevVar(devVarsText, newSecretName)
    if (newValue === null) throw new Error(`${newSecretName} is missing from .dev.vars`)
    const oldValue = getDevVar(updatedDevVarsText, oldSecretName)
    if (oldValue !== null && oldValue !== newValue) {
      throw new Error(`${oldSecretName} and ${newSecretName} have different local values`)
    }
    if (oldValue !== null) updatedDevVarsText = removeDevVar(updatedDevVarsText, oldSecretName)
    secretNames.push({ oldName: oldSecretName, newName: newSecretName })
  }

  const updatedRoutesText = removeLocalAlias && oldMatch
    ? withTrailingNewline(applyEdits(
        routesText,
        modify(routesText, ['sinks', oldMatch.index], undefined, { formattingOptions: FORMATTING_OPTIONS }),
      ))
    : routesText
  parseRoutes(updatedRoutesText)
  return { routesText: updatedRoutesText, devVarsText: updatedDevVarsText, secretNames }
}

function readRemoteSink(provider: ProviderConfigurationSnapshot, name: string): Record<string, unknown> {
  const value = provider.sinks[`sink:${name}`]
  if (value === undefined) {
    throw new Error(`remote sink alias is not ready: ${name}; apply the prepare phase first`)
  }
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    throw new Error(`remote sink alias is invalid: ${name}`)
  }
}

function assertRemoteSubscriptionsSwitched(routes: Routes, remote: ProviderConfigurationSnapshot): void {
  for (const sub of routes.subs) {
    const key = subscriptionKvKey(sub.slugHash)
    const value = remote.subs[key]
    if (value === undefined) {
      throw new Error(`remote subscription is not ready: ${sub.name}; apply the --switch phase first`)
    }
    let remoteSub: Record<string, unknown>
    try {
      remoteSub = JSON.parse(value) as Record<string, unknown>
    } catch {
      throw new Error(`remote subscription is invalid: ${sub.name}`)
    }
    if (canonicalize(remoteSub.sinks) !== canonicalize(sub.sinks) ||
        canonicalize(remoteSub.sinkFilters ?? {}) !== canonicalize(sub.sinkFilters ?? {})) {
      throw new Error(`remote subscription sink policy does not match local configuration: ${sub.name}`)
    }
  }
}

async function assertRemoteAliasesReady(
  routes: Routes,
  provider: ProviderConfigurationSnapshot,
  oldName: string,
  newName: string,
): Promise<Set<string>> {
  const oldSink = optionalNamedSink(routes, oldName)?.sink
  const newSink = namedSink(routes, newName).sink
  const remoteOldSink = readRemoteSink(provider, oldName)
  const remoteNewSink = readRemoteSink(provider, newName)
  const remoteSecrets = await listWranglerSecrets()
  if (canonicalize(remoteOldSink) !== canonicalize(sinkConfig(oldSink ?? newSink))) {
    throw new Error(`remote sink alias does not match local configuration: ${oldName}`)
  }
  if (canonicalize(remoteNewSink) !== canonicalize(sinkConfig(newSink))) {
    throw new Error(`remote sink alias does not match local configuration: ${newName}`)
  }
  for (const sink of oldSink ? [oldSink, newSink] : [newSink]) {
    for (const [field, value] of Object.entries(sinkRecord(sink))) {
      if (field.endsWith(ENV_REFERENCE_SUFFIX) && typeof value === 'string' && !remoteSecrets.has(value)) {
        throw new Error(`remote sink secret is not set: ${value}`)
      }
    }
  }
  return remoteSecrets
}

function nextCommand(oldName: string, newName: string, phase: RenamePhase): string {
  const phaseOption = phase === PREPARE_PHASE ? '' : ` --${phase}`
  return `pnpm sink:rename ${JSON.stringify(oldName)} ${JSON.stringify(newName)}${phaseOption}`
}

async function runPrepare(options: SinkRenameOptions, routesPath: string, devVarsPath: string): Promise<void> {
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const prepared = prepareSinkRename(routesText, devVarsText, options.oldName, options.newName)
  if (prepared.secrets.length > 0) {
    const remoteSecrets = await listWranglerSecrets()
    const collisions = prepared.secrets
      .map((secret) => secret.name)
      .filter((secretName) => remoteSecrets.has(secretName))
    if (collisions.length > 0) {
      throw new Error(`new remote secrets already exist and cannot be compared safely: ${collisions.join(', ')}`)
    }
  }
  await writeText(routesPath, prepared.routesText)
  await writePrivateText(devVarsPath, prepared.devVarsText)
  console.log(`Prepared compatible sink names ${options.oldName} and ${options.newName}`)
  for (const secret of prepared.secrets) console.log(`Prepared secret rename ${secret.oldName} -> ${secret.name}`)

  const production = await prepareProduction(prepared.secrets, options.yes, {
    puts: [prepared.oldSink, prepared.newSink].map(sink => ({ namespace: 'SINKS' as const, key: `sink:${sink.name}` })),
  })
  if (production === 'local-only') {
    console.log(`Production was not changed; install the new secret, then run pnpm sync --put-sink ${JSON.stringify(options.oldName)} --put-sink ${JSON.stringify(options.newName)} and add -y to apply`)
    return
  }
  if (production === 'previewed') {
    console.log(`The compatibility names were not deployed; run pnpm sync --put-sink ${JSON.stringify(options.oldName)} --put-sink ${JSON.stringify(options.newName)} -y before switching`)
    return
  }
  console.log(`Compatibility aliases deployed; next run ${nextCommand(options.oldName, options.newName, SWITCH_PHASE)}`)
}

async function runSwitch(options: SinkRenameOptions, routesPath: string): Promise<void> {
  const routesText = await readFile(routesPath, 'utf8')
  const routes = parseRoutes(routesText)
  const provider = await readProviderConfiguration()
  await assertRemoteAliasesReady(routes, provider, options.oldName, options.newName)
  const switched = switchSinkRename(routesText, options.oldName, options.newName)
  await writeText(routesPath, switched.routesText)
  if (switched.subscriptions.length === 0) console.log('No subscription references needed changing')
  else console.log(`Prepared subscription routing to ${options.newName}: ${switched.subscriptions.join(', ')}`)

  const switchedRoutes = parseRoutes(switched.routesText)
  const selected = switchedRoutes.subs.filter(sub => switched.subscriptions.includes(sub.name))
  const production = await prepareProduction(null, options.yes, {
    puts: selected.map(sub => ({
      namespace: 'SUBS' as const,
      key: subscriptionKvKey(sub.slugHash),
      policyFields: ['sinks', 'sinkFilters'] as const,
    })),
  })
  if (production === 'local-only') {
    console.log(`Production was not changed; rerun ${nextCommand(options.oldName, options.newName, SWITCH_PHASE)} to preview and apply the exact switch`)
    return
  }
  if (production === 'previewed') {
    console.log(`Subscription routing was not changed; rerun ${nextCommand(options.oldName, options.newName, SWITCH_PHASE)} -y before finalizing`)
    return
  }
  console.log(`Subscriptions switched; after provider propagation run ${nextCommand(options.oldName, options.newName, FINALIZE_PHASE)}`)
}

async function runFinalize(options: SinkRenameOptions, routesPath: string, devVarsPath: string): Promise<void> {
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const routes = parseRoutes(routesText)
  const provider = await readProviderConfiguration()
  const canonicalizeProvider = provider.state.mode === 'active'
  const finalized = finalizeSinkRename(
    routesText,
    devVarsText,
    options.oldName,
    options.newName,
    canonicalizeProvider,
  )
  const remoteSecrets = await assertRemoteAliasesReady(routes, provider, options.oldName, options.newName)
  assertRemoteSubscriptionsSwitched(routes, provider)
  const oldSecretNames = finalized.secretNames.map(({ oldName }) => oldName)
  if (oldSecretNames.length === 0 && !canonicalizeProvider) {
    console.log('No convention-derived secrets need finalizing')
    return
  }
  const action = oldSecretNames.length > 0
    ? `Finalize the provider identity and delete ${oldSecretNames.join(', ')} from Wrangler and .dev.vars?`
    : 'Finalize the provider sink identity?'
  if (!options.yes && !(await confirm(action))) {
    console.log('Finalization cancelled; old secrets were retained')
    return
  }

  const providerPlan = canonicalizeProvider
    ? await planProviderConfiguration(provider, {
      rekeys: [{
        namespace: 'SINKS',
        fromKey: `sink:${options.oldName}`,
        toKey: `sink:${options.newName}`,
        retainFromAlias: true,
        replaceTarget: true,
      }],
    })
    : null
  if (providerPlan) await applyProviderConfiguration(providerPlan)
  for (const secretName of oldSecretNames) {
    if (remoteSecrets.has(secretName)) await deleteWranglerSecret(secretName)
  }
  await writePrivateText(devVarsPath, finalized.devVarsText)
  if (canonicalizeProvider) await writeText(routesPath, finalized.routesText)
  if (oldSecretNames.length > 0) console.log(`Removed obsolete secrets: ${oldSecretNames.join(', ')}`)
  console.log(`Retained provider sink alias ${options.oldName} so queued and historical retries remain valid`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(sinkRenameUsage())
    return
  }
  const options = parseSinkRenameArgs(argv)
  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  if (options.phase === PREPARE_PHASE) await runPrepare(options, routesPath, devVarsPath)
  else if (options.phase === SWITCH_PHASE) await runSwitch(options, routesPath)
  else await runFinalize(options, routesPath, devVarsPath)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
