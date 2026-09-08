import { lstat, open, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ConfigurationError, readConfigurationReceipt, readConfigurationState } from '../src/configuration/authority'
import { operatorConfigurationQuery } from './configuration-client'
import {
  CONFIGURATION_OPERATOR, applyConfigurationReview, configurationReviewSummary, exportConfiguration,
  parseConfigurationReview, reviewConfigurationImport, reviewConfigurationMigration,
} from './configuration-workflow'
import { readRemoteKvSnapshot } from './kv'
import { confirm } from './setup'

export const PRIVATE_CONFIGURATION_FILE_BYTES = 1024 * 1024
const COMMANDS = ['status', 'export', 'migration-review', 'import-review', 'apply', 'receipt'] as const
type Command = typeof COMMANDS[number]
export interface ConfigurationOptions {
  command: Command
  config: string
  input?: string
  output?: string
  routes?: string
  operation?: string
  yes: boolean
}

export function configurationUsage(): string {
  return [
    'usage: pnpm configuration <command> [options]',
    '',
    'commands:',
    '  status                            Read authority mode and revision',
    '  export -o <new-file>              Save a private versioned export',
    '  migration-review -r <routes> -o <new-file>',
    '                                    Review KV activation and retain private recovery',
    '  import-review -i <draft> -o <new-file>',
    '                                    Review policy changes against the draft revision',
    '  apply -i <review> [-y]            Apply exactly the saved review [provider write]',
    '  receipt -p <operation-uuid>       Reconcile a possibly completed write',
    '',
    'options:',
    '  -c, --config <file>               Wrangler JSONC config (default: wrangler.jsonc)',
    '  -i, --input <file>                Private export draft or review file',
    '  -o, --output <file>               New owner-only file; never overwrite an existing file',
    '  -r, --routes <file>               Private legacy routes.jsonc for migration review',
    '  -p, --operation <uuid>            Exact operation ID returned by a review',
    '  -y, --yes                        Confirm apply without an interactive prompt',
    '  -h, --help                       Show this help',
    '',
    'Run from the selected Hookrelay deployment checkout with Node and locked dependencies installed.',
    'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required for all commands except help.',
    'The token needs D1 Read for reads, D1 Write for apply, and KV Read for migration review/apply.',
    'Migration reviews use the checkout\'s Wrangler config; a different -c is not supported for migration.',
    'Exports/reviews are version 1 JSON files, regular non-symlinks with mode 0600, at most 1 MiB.',
    'Keep the exported authorityId, revision and resource IDs. Imports support subscription policy only.',
    'Review files contain private recovery data. Never commit them or paste their content into diagnostics.',
    'Deployment does not activate the authority. Stop legacy writers before an explicit migration apply.',
    'Results are JSON on stdout; diagnostics/prompts use stderr. No command prints private entries.',
    'Exit status: 0 success/cancelled, 1 runtime or uncertain outcome, 2 usage/precondition failure.',
  ].join('\n')
}

export function parseConfigurationArgs(argv: string[]): ConfigurationOptions | null {
  try {
    const { values, positionals, tokens } = parseArgs({
      args: argv, allowPositionals: true, tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean', short: 'y' },
        config: { type: 'string', short: 'c' }, input: { type: 'string', short: 'i' },
        output: { type: 'string', short: 'o' }, routes: { type: 'string', short: 'r' }, operation: { type: 'string', short: 'p' },
      },
    })
    if (values.help) return null
    const seen = new Set<string>()
    for (const token of tokens) {
      if (token.kind !== 'option') continue
      if (seen.has(token.name) || token.value === '' || token.value?.startsWith('-')) throw new Error()
      seen.add(token.name)
    }
    if (positionals.length !== 1 || !COMMANDS.includes(positionals[0] as Command)) throw new Error()
    const command = positionals[0] as Command
    const required = {
      status: [], export: ['output'], 'migration-review': ['routes', 'output'],
      'import-review': ['input', 'output'], apply: ['input'], receipt: ['operation'],
    } as const
    const allowed = new Set<string>(['config', ...required[command], ...(command === 'apply' ? ['yes'] : [])])
    if (required[command].some(option => !values[option]) || [...seen].some(option => !allowed.has(option))) throw new Error()
    if (values.operation && !z.uuid().safeParse(values.operation).success) throw new Error()
    if (command === 'migration-review' && values.config && values.config !== 'wrangler.jsonc') throw new Error()
    return { command, config: values.config ?? 'wrangler.jsonc', ...values, yes: values.yes ?? false }
  } catch {
    throw new ConfigurationError('validation', 'Invalid configuration command; use pnpm configuration --help')
  }
}

export async function readPrivateConfigurationFile(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.size > PRIVATE_CONFIGURATION_FILE_BYTES) throw new Error()
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await file.stat()
    if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > PRIVATE_CONFIGURATION_FILE_BYTES) throw new Error()
    const text = await file.readFile('utf8')
    if (Buffer.byteLength(text) > PRIVATE_CONFIGURATION_FILE_BYTES) throw new Error()
    return text
  } catch {
    throw new ConfigurationError('validation', 'Private input must be an existing regular non-symlink file with mode 0600 within the documented size limit')
  } finally { await file?.close() }
}

export async function writeNewPrivateConfigurationFile(path: string, value: unknown): Promise<void> {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text) > PRIVATE_CONFIGURATION_FILE_BYTES) throw new ConfigurationError('validation', 'The private export exceeds the file size limit')
  let file: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    file = await open(path, 'wx', 0o600)
    created = true
    await file.chmod(0o600)
    await file.writeFile(text)
    await file.sync()
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error()
  } catch {
    if (created) await unlink(path).catch(() => {})
    throw new ConfigurationError('validation', 'Private output could not be saved; choose a new file in an existing owner-controlled directory')
  } finally { await file?.close() }
}

async function readPrivateJson(path: string): Promise<unknown> {
  const text = await readPrivateConfigurationFile(path)
  try { return JSON.parse(text) as unknown } catch {
    throw new ConfigurationError('validation', 'The private input is not valid JSON')
  }
}

export async function runConfigurationCommand(options: ConfigurationOptions): Promise<unknown> {
  const query = await operatorConfigurationQuery(options.config)
  switch (options.command) {
    case 'status': return readConfigurationState(query)
    case 'export': {
      const snapshot = await exportConfiguration(query)
      await writeNewPrivateConfigurationFile(options.output!, snapshot)
      return { saved: true, authorityId: snapshot.authorityId, revision: snapshot.revision, resourceCount: snapshot.entries.length }
    }
    case 'migration-review': {
      const routesText = await readPrivateConfigurationFile(options.routes!)
      const snapshot = await readRemoteKvSnapshot()
      const review = await reviewConfigurationMigration(query, snapshot, routesText)
      await writeNewPrivateConfigurationFile(options.output!, review)
      return configurationReviewSummary(review)
    }
    case 'import-review': {
      const review = await reviewConfigurationImport(query, await readPrivateJson(options.input!))
      await writeNewPrivateConfigurationFile(options.output!, review)
      return configurationReviewSummary(review)
    }
    case 'apply': {
      const review = await parseConfigurationReview(await readPrivateJson(options.input!))
      if (review.change.kind === 'migration' && options.config !== 'wrangler.jsonc') {
        throw new ConfigurationError('validation', 'Migration apply requires the deployment checkout\'s Wrangler configuration')
      }
      if (!options.yes && !await confirm(`Apply reviewed ${review.change.kind} ${review.change.operationId}?`)) return { applied: false, cancelled: true }
      return applyConfigurationReview(query, review, readRemoteKvSnapshot)
    }
    case 'receipt': {
      const receipt = await readConfigurationReceipt(query, options.operation!, CONFIGURATION_OPERATOR)
      if (!receipt) throw new ConfigurationError('not_found', 'No retained receipt was found; absence is not proof that an old operation never happened')
      return receipt
    }
  }
}

if (import.meta.main) {
  try {
    const options = parseConfigurationArgs(process.argv.slice(2))
    if (!options) console.log(configurationUsage())
    else console.log(JSON.stringify(await runConfigurationCommand(options), null, 2))
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : 'Configuration command failed; reconcile any uncertain write before retrying')
    process.exitCode = error instanceof ConfigurationError && error.code !== 'unavailable' ? 2 : 1
  }
}
