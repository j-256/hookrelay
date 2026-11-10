import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  extractOperatorGitHubAuthArgs,
  resolveOperatorGitHubAuth,
  requireOperatorGitHubAuthentication,
  operatorGitHubExitCode,
  OPERATOR_GITHUB_AUTH_USAGE,
  type OperatorGitHubAuthOptions,
} from './providers/github/auth'
import { GitHubAuthError } from '../src/lib/github-app-contract'
import { operatorConfigurationQuery } from './configuration-client'
import { readPrivateAppDocument } from './providers/github/app-private-file'
import {
  inspectGitHubHookOperations,
  previewGitHubHookOperationRecovery,
  reconcileGitHubHookOperation,
} from './providers/github/operation-recovery'
import { confirm } from './setup'

type Options = {
  command: 'list' | 'reconcile'
  authentication: OperatorGitHubAuthOptions
  config: string
  after?: string
  all: boolean
  file?: string
  yes: boolean
}
export function githubOperationsUsage() {
  return [
    'usage: pnpm github:operations <list|reconcile> [options]',
    '  ' + OPERATOR_GITHUB_AUTH_USAGE,
    '  -c, --config <file>    Wrangler JSONC (default wrangler.jsonc)',
    '  list [--after <id>] [--all]  Metadata only, bounded pages; default shows unresolved operations',
    '  reconcile -i <protected-file> [-y]  Review and record a fresh observation; may send a signed ping',
    '  -i, --file <file>      Owner-only regular non-symlink JSON, mode 0600',
    '  -y, --yes              Accept the exact protected review without a prompt',
    '  -h, --help             Show this help without provider access',
    '',
    'App/token modes require the live descriptor, workspace and protected credential file. gh has no registry journal.',
    'Private recovery schema: {operationId,expectedUpdatedAt,requestHash,originalRequest,acknowledgeUncertainOutcome:true,observation:"present"|"absent",expectedWebhookUrl?:string}.',
    'originalRequest is the exact create/update/events/delete/ping request, including private URL/HMAC when applicable.',
    'Ping recovery also requires expectedWebhookUrl. Delete recovery requires absent. Present recovery requires a fresh signed ping and matching active hook configuration.',
    'Wait for the original local request deadline before reconciling. A later observation does not prove how the original request ended or prevent a late provider effect.',
    'Historical outcomes remain unchanged. Reconciliation does not repeat the original mutation or deliver notifications to sinks.',
    'Never pass URL, HMAC or token values as arguments. Output and previews contain metadata only.',
    'Requires Node, pnpm, locked dependencies and selected Worker/D1 account credentials.',
    'Exit status: 0 success/cancelled/help, 1 failure or uncertainty, 2 usage/precondition error, 3 missing dependency.',
  ].join('\n')
}
export function parseGitHubOperationsArgs(args: string[]): Options | null {
  try {
    const extracted = extractOperatorGitHubAuthArgs(args)
    const { values, positionals, tokens } = parseArgs({
      args: extracted.args,
      allowPositionals: true,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        yes: { type: 'boolean', short: 'y' },
        config: { type: 'string', short: 'c' },
        file: { type: 'string', short: 'i' },
        after: { type: 'string' },
        all: { type: 'boolean' },
      },
    })
    if (values.help) return null
    const seen = new Set<string>()
    for (const token of tokens)
      if (token.kind === 'option') {
        if (seen.has(token.name) || token.value === '' || token.value?.startsWith('-'))
          throw new Error()
        seen.add(token.name)
      }
    if (positionals.length !== 1 || !['list', 'reconcile'].includes(positionals[0]!))
      throw new Error()
    if (!extracted.authentication) requireOperatorGitHubAuthentication()
    if (extracted.authentication.mode === 'gh') throw new Error()
    const command = positionals[0] as Options['command']
    if (
      command === 'list'
        ? values.file !== undefined || values.yes !== undefined
        : !values.file || values.after !== undefined || values.all !== undefined
    )
      throw new Error()
    if (values.after && !z.uuid().safeParse(values.after).success) throw new Error()
    return {
      command,
      authentication: extracted.authentication,
      config: values.config ?? 'wrangler.jsonc',
      after: values.after,
      all: values.all ?? false,
      file: values.file,
      yes: values.yes ?? false,
    }
  } catch {
    throw new GitHubAuthError('validation')
  }
}
export async function runGitHubOperationsCommand(options: Options) {
  const query = await operatorConfigurationQuery(options.config)
  const auth = await resolveOperatorGitHubAuth(
    { ...options.authentication, config: options.config },
    { query },
  )
  if (options.command === 'list')
    return inspectGitHubHookOperations(query, auth, { after: options.after, all: options.all })
  const review = (await readPrivateAppDocument(options.file!)).value
  console.error(JSON.stringify(await previewGitHubHookOperationRecovery(query, auth, review)))
  if (
    !options.yes &&
    !(await confirm(
      'Record this exact later observation, retaining the original uncertain outcome?',
    ))
  )
    return { cancelled: true }
  return reconcileGitHubHookOperation(query, auth, review)
}
if (import.meta.main) {
  try {
    const options = parseGitHubOperationsArgs(process.argv.slice(2))
    if (!options) console.log(githubOperationsUsage())
    else console.log(JSON.stringify(await runGitHubOperationsCommand(options), null, 2))
  } catch (error) {
    console.error(
      error instanceof GitHubAuthError
        ? error.message
        : 'GitHub operation recovery failed; retain the protected review and inspect its receipt',
    )
    process.exitCode = operatorGitHubExitCode(error)
  }
}
