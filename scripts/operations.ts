import { parseArgs } from 'node:util'
import { z } from 'zod'
import { ConfigurationError } from '../src/configuration/authority'
import { applyOperationalResolution, planOperationalResolution, readOperationalResolution, readOperationalSignals, signalCursor } from '../src/operational-review'
import { CONFIGURATION_OPERATOR, operatorConfigurationQuery } from './configuration-client'
import { readPrivateConfigurationFile } from './configuration'
import { confirm } from './setup'

const COMMANDS = ['signals', 'plan', 'apply', 'receipt'] as const
export function operationsUsage(): string {
  return [
    'usage: pnpm operations <signals|plan|apply|receipt> [options]',
    '',
    'commands:',
    '  signals [-u <cursor-file>] [-r]   Read one page of open signals, or resolved signals with -r',
    '  plan -i <review-input>            Save an exact-state review; no signals or deliveries change',
    '  apply -p <plan-uuid> [-y]          Accept the reviewed disposition without sending messages',
    '  receipt -p <plan-uuid>             Recover the original review or accepted receipt',
    '',
    'options:',
    '  -c, --config <file>               Wrangler JSONC config (default: wrangler.jsonc)',
    '  -i, --input <file>                Private JSON review input',
    '  -u, --cursor <file>               Private JSON nextCursor returned by signals',
    '  -r, --resolved                    List resolved signals',
    '  -p, --plan <uuid>                 Exact provider review identity',
    '  -y, --yes                         Confirm apply without an interactive prompt',
    '  -h, --help                        Show help',
    '',
    'Run from a Hookrelay checkout with Node, pnpm, and locked dependencies installed.',
    'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required except for help.',
    'The account token requires D1 Read for reads and D1 Write for plan/apply.',
    'Inputs must be regular non-symlink files with mode 0600, at most 1 MiB.',
    'Review JSON: {planId: UUID, reason: recovered|obsolete|accepted-loss, note: printable ASCII, targets: [...]}.',
    'A note is required (up to 500 characters); never include secrets, payloads, or private URLs.',
    'Use 1-25 unique targets: {kind: signal, fingerprint, lastSeenAt, occurrences} or',
    '{kind: delivery, eventId, sinkName, generation, updatedAt}. Timestamps use ISO UTC format.',
    'Copy state from a fresh metadata read. The review expires after five minutes.',
    'Resolution preserves exhausted delivery state and retained events; it does not assert successful delivery.',
    'Receipts identify cloudflare-operator/account-operator, not a verified individual human.',
    'Results are JSON on stdout; prompts/diagnostics use stderr. Reconcile uncertain apply with receipt.',
    'Exit status: 0 success/cancelled, 1 runtime/uncertain outcome, 2 usage/precondition failure.',
  ].join('\n')
}

export function parseOperationsArgs(argv: string[]) {
  try {
    const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      help: { type: 'boolean', short: 'h' }, config: { type: 'string', short: 'c' },
      input: { type: 'string', short: 'i' }, cursor: { type: 'string', short: 'u' },
      plan: { type: 'string', short: 'p' }, yes: { type: 'boolean', short: 'y' }, resolved: { type: 'boolean', short: 'r' },
    } })
    if (values.help) return null
    const seen = new Set<string>()
    for (const token of tokens) {
      if (token.kind !== 'option') continue
      if (seen.has(token.name) || token.value === '' || token.value?.startsWith('-')) throw new Error()
      seen.add(token.name)
    }
    if (positionals.length !== 1 || !COMMANDS.includes(positionals[0] as typeof COMMANDS[number])) throw new Error()
    const command = positionals[0] as typeof COMMANDS[number]
    const allowed = new Set(['config', ...({ signals: ['cursor', 'resolved'], plan: ['input'], apply: ['plan', 'yes'], receipt: ['plan'] })[command]])
    if ([...seen].some(option => !allowed.has(option))) throw new Error()
    if (command === 'plan' && !values.input) throw new Error()
    if ((command === 'apply' || command === 'receipt') && !z.uuid().safeParse(values.plan).success) throw new Error()
    return { ...values, command, config: values.config ?? 'wrangler.jsonc' }
  } catch {
    throw new ConfigurationError('validation', 'Invalid operations command; use pnpm operations --help')
  }
}

async function readJson(path: string) {
  const text = await readPrivateConfigurationFile(path)
  try { return JSON.parse(text) as unknown } catch {
    throw new ConfigurationError('validation', 'Private input is not valid JSON')
  }
}

export async function runOperationsCommand(options: NonNullable<ReturnType<typeof parseOperationsArgs>>) {
  const query = await operatorConfigurationQuery(options.config)
  switch (options.command) {
    case 'signals': return readOperationalSignals(query, {
      cursor: options.cursor ? signalCursor.parse(await readJson(options.cursor)) : null, resolved: options.resolved ?? false,
    })
    case 'plan': return planOperationalResolution(query, CONFIGURATION_OPERATOR, await readJson(options.input!))
    case 'receipt': return readOperationalResolution(query, CONFIGURATION_OPERATOR, options.plan!)
    case 'apply': {
      const review = await readOperationalResolution(query, CONFIGURATION_OPERATOR, options.plan!)
      console.error(JSON.stringify(review, null, 2))
      if (!options.yes && !await confirm('Accept this operational disposition without sending messages?')) return { cancelled: true }
      return applyOperationalResolution(query, CONFIGURATION_OPERATOR, options.plan!)
    }
  }
}

if (import.meta.main) {
  try {
    const options = parseOperationsArgs(process.argv.slice(2))
    if (!options) console.log(operationsUsage())
    else console.log(JSON.stringify(await runOperationsCommand(options), null, 2))
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : error instanceof z.ZodError
      ? 'Operational input is invalid; inspect the documented schema' : 'Operations command failed; reconcile any uncertain apply by receipt')
    process.exitCode = error instanceof z.ZodError || (error instanceof ConfigurationError && error.code !== 'unavailable') ? 2 : 1
  }
}
