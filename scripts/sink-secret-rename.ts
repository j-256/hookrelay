import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  addDevVar,
  confirm,
  deleteWranglerSecret,
  getDevVar,
  listWranglerSecrets,
  prepareProduction,
  readOptionalText,
  removeDevVar,
  runProcess,
  type SecretValue,
  writePrivateText,
  writeText,
} from './setup'
import { parseRoutes, type Routes, type SinkRef } from './sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const PREPARE_PHASE = 'prepare'
const FINALIZE_PHASE = 'finalize'
const ENV_REFERENCE_SUFFIX = 'Env'
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

type SecretRenamePhase = typeof PREPARE_PHASE | typeof FINALIZE_PHASE

export interface SinkSecretRenameOptions {
  sinkName: string
  oldSecretName: string
  newSecretName: string
  phase: SecretRenamePhase
  yes: boolean
}

export interface PreparedSinkSecretRename {
  routesText: string
  devVarsText: string
  fieldName: string
  secret: SecretValue
}

export interface FinalizedSinkSecretRename {
  devVarsText: string
  fieldName: string
  removedLocalSecret: boolean
}

export function sinkSecretRenameUsage(): string {
  return [
    'usage: pnpm sink:secret:rename <sink-name> <old-secret> <new-secret> [--finalize] [-y]',
    '',
    'phases:',
    '  default     copy the secret, switch the sink *Env reference, and sync KV',
    '  --finalize  delete the obsolete secret after the KV change has propagated',
    '',
    'options:',
    '  -y, --yes   apply production changes without prompts',
    '  -h, --help  show this help',
  ].join('\n')
}

function assertSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`invalid secret name: ${name}`)
}

export function parseSinkSecretRenameArgs(argv: string[]): SinkSecretRenameOptions {
  const positional: string[] = []
  let phase: SecretRenamePhase = PREPARE_PHASE
  let phaseSelected = false
  let yes = false

  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--help' || arg === '-h') throw new Error(sinkSecretRenameUsage())
    else if (arg === '--prepare' || arg === '--finalize') {
      if (phaseSelected) throw new Error('choose only one rename phase')
      phase = arg.slice(2) as SecretRenamePhase
      phaseSelected = true
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else positional.push(arg)
  }

  if (positional.length !== 3) throw new Error(sinkSecretRenameUsage())
  const [sinkName, oldSecretName, newSecretName] = positional as [string, string, string]
  if (oldSecretName === newSecretName) throw new Error('old and new secret names must differ')
  assertSecretName(oldSecretName)
  assertSecretName(newSecretName)
  return { sinkName, oldSecretName, newSecretName, phase, yes }
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

function namedSink(routes: Routes, name: string): { sink: SinkRef; index: number } {
  const matches = routes.sinks
    .map((sink, index) => ({ sink, index }))
    .filter(({ sink }) => sink.name === name)
  if (matches.length === 0) throw new Error(`sink does not exist: ${name}`)
  if (matches.length > 1) throw new Error(`sink is declared more than once: ${name}`)
  return matches[0]!
}

function matchingEnvField(sink: SinkRef, secretName: string): string {
  const fields = Object.entries(sinkRecord(sink))
    .filter(([field, value]) => field.endsWith(ENV_REFERENCE_SUFFIX) && value === secretName)
    .map(([field]) => field)
  if (fields.length === 0) {
    throw new Error(`sink ${sink.name} does not reference ${secretName} through an *Env field`)
  }
  if (fields.length > 1) {
    throw new Error(`sink ${sink.name} references ${secretName} through more than one *Env field`)
  }
  return fields[0]!
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

export function prepareSinkSecretRename(
  routesText: string,
  devVarsText: string,
  sinkName: string,
  oldSecretName: string,
  newSecretName: string,
): PreparedSinkSecretRename {
  const routes = parseRoutes(routesText)
  const { sink, index } = namedSink(routes, sinkName)
  const fieldName = matchingEnvField(sink, oldSecretName)
  if (routeContainsValue(routes, newSecretName)) {
    throw new Error(`new secret name is already referenced: ${newSecretName}`)
  }

  const value = getDevVar(devVarsText, oldSecretName)
  if (value === null) {
    throw new Error(`${oldSecretName} is missing from .dev.vars; Wrangler cannot return deployed secret values`)
  }
  if (getDevVar(devVarsText, newSecretName) !== null) {
    throw new Error(`${newSecretName} already exists in .dev.vars`)
  }

  const updatedRoutesText = withTrailingNewline(applyEdits(
    routesText,
    modify(routesText, ['sinks', index, fieldName], newSecretName, {
      formattingOptions: FORMATTING_OPTIONS,
    }),
  ))
  parseRoutes(updatedRoutesText)

  return {
    routesText: updatedRoutesText,
    devVarsText: addDevVar(devVarsText, newSecretName, value),
    fieldName,
    secret: { name: newSecretName, value },
  }
}

export function finalizeSinkSecretRename(
  routesText: string,
  devVarsText: string,
  sinkName: string,
  oldSecretName: string,
  newSecretName: string,
): FinalizedSinkSecretRename {
  const routes = parseRoutes(routesText)
  const { sink } = namedSink(routes, sinkName)
  const fieldName = matchingEnvField(sink, newSecretName)
  if (routeContainsValue(routes, oldSecretName)) {
    throw new Error(`cannot delete secret while routes still reference it: ${oldSecretName}`)
  }

  const newValue = getDevVar(devVarsText, newSecretName)
  if (newValue === null) throw new Error(`${newSecretName} is missing from .dev.vars`)
  const oldValue = getDevVar(devVarsText, oldSecretName)
  if (oldValue !== null && oldValue !== newValue) {
    throw new Error(`${oldSecretName} and ${newSecretName} have different local values`)
  }

  return {
    devVarsText: oldValue === null ? devVarsText : removeDevVar(devVarsText, oldSecretName),
    fieldName,
    removedLocalSecret: oldValue !== null,
  }
}

async function readRemoteSink(name: string): Promise<Record<string, unknown>> {
  let stdout: string
  try {
    stdout = await runProcess(
      'npx',
      ['wrangler', 'kv', 'key', 'get', `sink:${name}`, '--binding', 'SINKS', '--text', '--remote'],
      { captureStdout: true },
    )
  } catch {
    throw new Error(`remote sink is not ready: ${name}; apply the prepare phase first`)
  }
  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error(`remote sink is invalid: ${name}`)
  }
}

async function assertRemoteRenameReady(
  routes: Routes,
  sinkName: string,
  newSecretName: string,
): Promise<Set<string>> {
  const sink = namedSink(routes, sinkName).sink
  const [remoteSink, remoteSecrets] = await Promise.all([
    readRemoteSink(sinkName),
    listWranglerSecrets(),
  ])
  if (canonicalize(remoteSink) !== canonicalize(sinkConfig(sink))) {
    throw new Error(`remote sink does not match local configuration: ${sinkName}`)
  }
  if (!remoteSecrets.has(newSecretName)) {
    throw new Error(`new remote sink secret is not set: ${newSecretName}`)
  }
  return remoteSecrets
}

function finalizeCommand(options: SinkSecretRenameOptions): string {
  return [
    'pnpm sink:secret:rename',
    JSON.stringify(options.sinkName),
    JSON.stringify(options.oldSecretName),
    JSON.stringify(options.newSecretName),
    '--finalize',
  ].join(' ')
}

async function runPrepare(
  options: SinkSecretRenameOptions,
  routesPath: string,
  devVarsPath: string,
): Promise<void> {
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const prepared = prepareSinkSecretRename(
    routesText,
    devVarsText,
    options.sinkName,
    options.oldSecretName,
    options.newSecretName,
  )
  const remoteSecrets = await listWranglerSecrets()
  if (remoteSecrets.has(options.newSecretName)) {
    throw new Error(`new remote secret already exists and cannot be compared safely: ${options.newSecretName}`)
  }
  await writeText(routesPath, prepared.routesText)
  await writePrivateText(devVarsPath, prepared.devVarsText)
  console.log(`Prepared ${options.sinkName}.${prepared.fieldName}: ${options.oldSecretName} -> ${options.newSecretName}`)

  const production = await prepareProduction(prepared.secret, options.yes)
  if (production === 'local-only') {
    console.log(`Production was not changed; install ${options.newSecretName}, then run pnpm sync and pnpm sync -y`)
    return
  }
  if (production === 'previewed') {
    console.log('The sink secret reference was not changed; run pnpm sync -y before finalizing')
    return
  }
  console.log(`Sink secret reference changed; after KV propagation run ${finalizeCommand(options)}`)
}

async function runFinalize(
  options: SinkSecretRenameOptions,
  routesPath: string,
  devVarsPath: string,
): Promise<void> {
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const routes = parseRoutes(routesText)
  const finalized = finalizeSinkSecretRename(
    routesText,
    devVarsText,
    options.sinkName,
    options.oldSecretName,
    options.newSecretName,
  )
  const remoteSecrets = await assertRemoteRenameReady(routes, options.sinkName, options.newSecretName)
  if (!options.yes && !(await confirm(`Delete ${options.oldSecretName} from Wrangler and .dev.vars?`))) {
    console.log('Finalization cancelled; the old secret was retained')
    return
  }

  if (remoteSecrets.has(options.oldSecretName)) await deleteWranglerSecret(options.oldSecretName)
  if (finalized.removedLocalSecret) await writePrivateText(devVarsPath, finalized.devVarsText)
  console.log(`Removed obsolete secret ${options.oldSecretName}`)
  console.log(`Sink ${options.sinkName} remains the delivery identity`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(sinkSecretRenameUsage())
    return
  }
  const options = parseSinkSecretRenameArgs(argv)
  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  if (options.phase === PREPARE_PHASE) await runPrepare(options, routesPath, devVarsPath)
  else await runFinalize(options, routesPath, devVarsPath)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
