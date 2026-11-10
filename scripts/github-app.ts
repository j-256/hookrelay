import { parseArgs } from 'node:util'
import { z } from 'zod'
import { GitHubAuthError, GITHUB_APP_LIMITS } from '../src/lib/github-app-contract'
import {
  importGitHubAppMaterial,
  runGitHubAppRegistration,
} from './providers/github/app-registration'
import {
  readGitHubAppPrivateFile,
  readGitHubCredentialPrivateFile,
  importGitHubTokenMaterial,
  readPrivateAppDocument,
  replacePrivateAppDocument,
} from './providers/github/app-private-file'
import { createOperatorConfigurationQuery } from './configuration-client'
import {
  prepareGitHubAppDeployment,
  stageGitHubAppWorkerKey,
  deployGitHubAppWorkerVersion,
  verifyGitHubAppWorkerKey,
  activateGitHubAppDeployment,
  previewGitHubAppDeployment,
  reconcileGitHubAppDeployment,
  readGitHubWorkerIdentity,
  createGitHubAppDeploymentProvider,
  readGitHubAppOperatorStatus,
  disconnectGitHubAppDescriptor,
  type GitHubAppDeploymentInput,
} from './providers/github/app-deployment'
import { confirm, runProcess } from './setup'

const COMMANDS = [
  'register',
  'import',
  'import-token',
  'inspect',
  'prepare',
  'stage',
  'deploy',
  'verify',
  'activate',
  'status',
  'reconcile',
  'disconnect',
] as const
export type GitHubAppOptions = {
  command: (typeof COMMANDS)[number]
  config: string
  yes: boolean
  file?: string
  output?: string
  attempt?: string
  account?: string
  accountType?: 'User' | 'Organization'
  name?: string
  visibility?: 'private' | 'public'
  homepage?: string
  capability?: 'repository-hooks-read' | 'repository-hooks-write'
  input?: string
  candidate?: string
  descriptor?: string
}
export function githubAppUsage() {
  return [
    'usage: pnpm github:app <register|import|import-token|inspect|prepare|stage|deploy|verify|activate|status|disconnect> [options]',
    '',
    'register -a <login> -t User|Organization -n <name> -v private|public -u <https-homepage> -e repository-hooks-read|repository-hooks-write -o <new-private-file> -j <new-attempt-file> [-y]',
    '    Open a loopback manifest ceremony. Creating the App on GitHub is explicit. No deployment or activation.',
    'import -i <private-file|-> -o <new-private-file>    Verify one App identity and save protected recovery locally',
    'import-token -i <private-file|-> -o <new-private-file> Save a manual token locally; no provider access or activation',
    'inspect -i <private-file>                         Show metadata from a recovery file or registration attempt',
    'prepare -i <recovery> -p <metadata-input>          Review an inactive provider registry candidate',
    '    Metadata: {descriptor,expectedRevision,baseVersionId,verificationOrigin,variableLimit?:64|128}. Select the exact 100-percent serving code version; code upgrades use the checked deployment workflow.',
    '    Descriptor: explicit App/install/account IDs, numeric repositories, managementWorkspaces and hook capabilities.',
    '    Include id, revision, keyRevision, a NEW keySecretName, public fingerprint, mode app and state active. Token descriptors use mode token and a NEW tokenSecretName.',
    '    Variable capacity defaults to Free 64; explicitly review 128 for Paid. New secret material is bounded to 5000 bytes.',
    '    The serving base must also be the latest uploaded version and bind EVENTS_DB and CF_VERSION_METADATA. Prepare stages no secret and deploys no code.',
    'stage -i <recovery> -d <candidate> [-y]            Stage a named key/version without serving it',
    'deploy -i <recovery> -d <candidate> [-y]           Deploy the exact staged version [provider write]',
    'verify -i <recovery> -d <candidate>               Verify serving version and loaded credential identity',
    'activate -i <recovery> -d <candidate> [-y]         Activate only the attested candidate by revision CAS',
    'reconcile -d <candidate> [-y]                     Append historical version readback even after expiry; no key or activation',
    'status -r <descriptor>                            Read selected provider auth metadata',
    'disconnect -r <descriptor> [-y]                   Review and locally disable selected provider auth',
    '',
    '-c, --config <file> selects Wrangler JSONC (default wrangler.jsonc); -h/--help shows help.',
    '-i/--file, -o/--output, -j/--attempt, -a/--account, -t/--account-type, -n/--name, -v/--visibility,',
    '-u/--homepage, -e/--capability, -p/--input, -d/--candidate, -r/--descriptor, -y/--yes.',
    'Private import schema: {version:1,appId:positive integer,privateKey:PEM,webhookSecret:optional string}.',
    'Private token import schema: {version:1,token:string}; working repository identity is checked during prepare.',
    'Keys must be RSA PKCS1/PKCS8, at least 2048 bits. Generated recovery files are version 1, kind github-app.',
    'Private files must be owner-only regular non-symlinks, mode 0600 and at most 64 KiB; output parents must be owner-controlled.',
    'An attempt file preserves claimed or indeterminate conversion. Inspect it before explicit recovery; no conversion replay.',
    'Node, pnpm and locked dependencies are required. Browser opening uses the platform opener; import supports headless operation.',
    'Register/import contact fixed GitHub endpoints; register listens on 127.0.0.1 for at most ten minutes.',
    'Provider lifecycle commands require CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN with selected Worker/D1 scopes.',
    'Results are metadata-only JSON on stdout; previews and diagnostics use stderr. Never pass key/token values in arguments.',
    'Exit status: 0 success/cancelled/help, 1 runtime or uncertain outcome, 2 usage/precondition error, 3 missing dependency.',
  ].join('\n')
}
export function parseGitHubAppArgs(args: string[]): GitHubAppOptions | null {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        yes: { type: 'boolean', short: 'y' },
        config: { type: 'string', short: 'c' },
        file: { type: 'string', short: 'i' },
        output: { type: 'string', short: 'o' },
        attempt: { type: 'string', short: 'j' },
        account: { type: 'string', short: 'a' },
        'account-type': { type: 'string', short: 't' },
        name: { type: 'string', short: 'n' },
        visibility: { type: 'string', short: 'v' },
        homepage: { type: 'string', short: 'u' },
        capability: { type: 'string', short: 'e' },
        input: { type: 'string', short: 'p' },
        candidate: { type: 'string', short: 'd' },
        descriptor: { type: 'string', short: 'r' },
      },
    })
    if (values.help) return null
    const seen = new Set<string>()
    for (const token of tokens)
      if (token.kind === 'option') {
        if (
          seen.has(token.name) ||
          token.value === '' ||
          (token.value?.startsWith('-') && !(token.name === 'file' && token.value === '-'))
        )
          throw new Error()
        seen.add(token.name)
      }
    if (
      positionals.length !== 1 ||
      !COMMANDS.includes(positionals[0] as GitHubAppOptions['command'])
    )
      throw new Error()
    const command = positionals[0] as GitHubAppOptions['command']
    const required = {
      register: [
        'account',
        'account-type',
        'name',
        'visibility',
        'homepage',
        'capability',
        'output',
        'attempt',
      ],
      import: ['file', 'output'],
      'import-token': ['file', 'output'],
      inspect: ['file'],
      prepare: ['file', 'input'],
      stage: ['file', 'candidate'],
      deploy: ['file', 'candidate'],
      verify: ['file', 'candidate'],
      activate: ['file', 'candidate'],
      status: ['descriptor'],
      reconcile: ['candidate'],
      disconnect: ['descriptor'],
    } as const
    const allowed = new Set<string>([
      ...required[command],
      ...(['register', 'stage', 'deploy', 'activate', 'disconnect', 'reconcile'].includes(command)
        ? ['yes']
        : []),
      ...(!['register', 'import', 'import-token', 'inspect'].includes(command) ? ['config'] : []),
    ])
    if (required[command].some((key) => !values[key]) || [...seen].some((key) => !allowed.has(key)))
      throw new Error()
    if (values['account-type'] && !['User', 'Organization'].includes(values['account-type']))
      throw new Error()
    if (values.visibility && !['private', 'public'].includes(values.visibility)) throw new Error()
    if (
      values.capability &&
      !['repository-hooks-read', 'repository-hooks-write'].includes(values.capability)
    )
      throw new Error()
    if (values.candidate && !z.uuid().safeParse(values.candidate).success) throw new Error()
    if (values.file === '-' && !['import', 'import-token'].includes(command)) throw new Error()
    const { help: _help, 'account-type': accountType, ...selected } = values
    return {
      ...selected,
      command,
      config: values.config ?? 'wrangler.jsonc',
      yes: values.yes ?? false,
      ...(accountType ? { accountType: accountType as 'User' | 'Organization' } : {}),
    } as GitHubAppOptions
  } catch {
    throw new GitHubAuthError('validation')
  }
}
async function privateInput(path: string) {
  if (path !== '-') return (await readPrivateAppDocument(path)).value
  if (process.stdin.isTTY) throw new GitHubAuthError('validation')
  const chunks: Buffer[] = []
  let length = 0
  const timer = setTimeout(() => process.stdin.destroy(new GitHubAuthError('unavailable')), 15000)
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk)
      length += bytes.length
      if (length > GITHUB_APP_LIMITS.PRIVATE_BYTES) throw new GitHubAuthError('validation')
      chunks.push(bytes)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new GitHubAuthError('validation')
  } finally {
    clearTimeout(timer)
    chunks.forEach((chunk) => chunk.fill(0))
  }
}
export async function runGitHubAppCommand(options: GitHubAppOptions) {
  if (options.command === 'import-token')
    return importGitHubTokenMaterial(await privateInput(options.file!), options.output!)
  if (options.command === 'inspect') {
    const document = (await readPrivateAppDocument(options.file!)).value
    const attempt = z
      .object({
        kind: z.literal('github-app-registration'),
        id: z.uuid(),
        state: z.enum(['pending', 'conversion_claimed', 'indeterminate', 'expired', 'prepared']),
        expiresAt: z.number().int(),
        recovery: z.unknown().optional(),
      })
      .safeParse(document)
    if (attempt.success)
      return {
        attemptId: attempt.data.id,
        state: attempt.data.state === 'conversion_claimed' ? 'indeterminate' : attempt.data.state,
        expiresAt: attempt.data.expiresAt,
        recoveryMaterialRetained: attempt.data.recovery !== undefined,
      }
    const recovery = await readGitHubCredentialPrivateFile(options.file!)
    if (recovery.kind === 'github-token')
      return {
        kind: recovery.kind,
        fingerprint: recovery.fingerprint,
        deploymentReceipts: recovery.deploymentReceipts ?? [],
      }
    return {
      appId: recovery.app.id,
      slug: recovery.app.slug,
      fingerprint: recovery.fingerprint,
      lifecycleIngress: 'inactive',
      deploymentReceipts: recovery.deploymentReceipts ?? [],
    }
  }
  if (options.command === 'import') {
    let value = await privateInput(options.file!)
    const full = z.object({ kind: z.literal('github-app') }).safeParse(value)
    if (full.success && options.file !== '-') {
      const recovery = await readGitHubAppPrivateFile(options.file!)
      value = {
        version: 1,
        appId: recovery.app.id,
        privateKey: recovery.privateKey,
        ...(recovery.webhookSecret ? { webhookSecret: recovery.webhookSecret } : {}),
      }
    }
    return importGitHubAppMaterial(value, options.output!)
  }
  if (options.command === 'register') {
    console.error(
      JSON.stringify({
        account: options.account,
        accountType: options.accountType,
        name: options.name,
        visibility: options.visibility,
        capability: options.capability,
        effects: [
          'GitHub App registration after browser confirmation',
          'local protected recovery files',
        ],
      }),
    )
    if (!options.yes && !(await confirm('Open this App registration ceremony?')))
      return { cancelled: true }
    const signal = new AbortController()
    const abort = () => signal.abort()
    process.once('SIGINT', abort)
    try {
      return await runGitHubAppRegistration({
        account: { login: options.account!, type: options.accountType! },
        name: options.name!,
        visibility: options.visibility!,
        homepage: options.homepage!,
        capability: options.capability!,
        attemptFile: options.attempt!,
        outputFile: options.output!,
        signal: signal.signal,
        openBrowser: async (url) => {
          await runProcess(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
            captureStdout: true,
            privateOutput: true,
          })
        },
      })
    } finally {
      process.removeListener('SIGINT', abort)
    }
  }
  const selected = await readGitHubWorkerIdentity(options.config)
  const query = createOperatorConfigurationQuery(selected.databaseId)
  if (options.command === 'status') return readGitHubAppOperatorStatus(query, options.descriptor!)
  if (options.command === 'disconnect') {
    const before = await readGitHubAppOperatorStatus(query, options.descriptor!)
    console.error(
      JSON.stringify({
        ...before,
        effects: [
          'Disable this descriptor and invalidate its authority; retain upstream installation, hooks and old keys',
        ],
      }),
    )
    if (!options.yes && !(await confirm('Disconnect this exact provider descriptor?')))
      return { cancelled: true }
    return disconnectGitHubAppDescriptor(query, before.descriptorId, before.revision)
  }
  if (options.command === 'reconcile') {
    const deps = {
      query,
      provider: createGitHubAppDeploymentProvider(selected.target),
      recoveryFile: '',
      configPath: options.config,
      currentIdentity: () => readGitHubWorkerIdentity(options.config),
    }
    const preview = await previewGitHubAppDeployment(options.candidate!, deps, true)
    console.error(JSON.stringify({
      ...preview,
      effect: 'Append an exact historical observation; do not deploy or restore activation authority',
    }))
    if (!options.yes && !(await confirm('Record this historical deployment observation?')))
      return { cancelled: true }
    return reconcileGitHubAppDeployment(options.candidate!, deps)
  }
  const document = await readPrivateAppDocument(options.file!)
  const recovery = await readGitHubCredentialPrivateFile(options.file!)
  const deps = {
    query,
    provider: createGitHubAppDeploymentProvider(selected.target),
    recoveryFile: options.file!,
    configPath: options.config,
    currentIdentity: () => readGitHubWorkerIdentity(options.config),
  }
  if (options.command === 'prepare') {
    const input = (await readPrivateAppDocument(options.input!)).value
    if (
      typeof input !== 'object' ||
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            'descriptor',
            'expectedRevision',
            'baseVersionId',
            'verificationOrigin',
            'variableLimit',
          ].includes(key),
      )
    )
      throw new GitHubAuthError('validation')
    return prepareGitHubAppDeployment({ ...selected, ...input } as GitHubAppDeploymentInput, deps)
  }
  const preview = await previewGitHubAppDeployment(options.candidate!, deps)
  if (
    (recovery.deploymentReceipts?.length ?? 0) >= 100 &&
    !recovery.deploymentReceipts?.some((item) => item.candidateId === options.candidate)
  )
    throw new GitHubAuthError('validation')
  console.error(
    JSON.stringify({
      ...preview,
      effect:
        options.command === 'stage'
          ? 'Create an undeployed version retaining prior secrets'
          : options.command === 'deploy'
            ? 'Serve this exact staged code/key version at 100 percent'
            : options.command === 'verify'
              ? 'Consume a protected one-use key challenge'
              : 'Activate this verified descriptor by revision CAS',
    }),
  )
  if (
    options.command !== 'verify' &&
    !options.yes &&
    !(await confirm('Accept this exact ' + options.command + ' effect?'))
  )
    return { cancelled: true }
  const actions = {
    stage: stageGitHubAppWorkerKey,
    deploy: deployGitHubAppWorkerVersion,
    verify: verifyGitHubAppWorkerKey,
    activate: activateGitHubAppDeployment,
  }
  const result = await actions[options.command](options.candidate!, deps)
  const recorded = {
    candidateId: options.candidate!,
    phase: 'phase' in result ? result.phase : result.state,
    versionId: result.versionId,
    attestationId: 'attestationId' in result ? result.attestationId : preview.attestationId,
    recordedAt: new Date().toISOString(),
  }
  await replacePrivateAppDocument(options.file!, document.digest, {
    ...recovery,
    deploymentReceipts: [
      ...(recovery.deploymentReceipts ?? []).filter(
        (item) => item.candidateId !== options.candidate,
      ),
      recorded,
    ],
  })
  return result
}
export function gitHubAppResultExitStatus(result: unknown): 0 | 1 {
  if (!result || typeof result !== 'object' || !('phase' in result)) return 0
  const completed = [
    'prepared', 'staged', 'deployed', 'verified', 'active', 'disconnected',
    'historical_staged', 'historical_deployed',
  ]
  return completed.includes(String(result.phase)) ? 0 : 1
}
if (import.meta.main) {
  try {
    const options = parseGitHubAppArgs(process.argv.slice(2))
    if (!options) console.log(githubAppUsage())
    else {
      const result = await runGitHubAppCommand(options)
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = gitHubAppResultExitStatus(result)
    }
  } catch (error) {
    console.error(
      error instanceof GitHubAuthError
        ? error.message
        : 'App operation failed; inspect the protected receipt before retrying',
    )
    process.exitCode =
      error instanceof GitHubAuthError && error.code === 'validation'
        ? 2
        : (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 3
          : 1
  }
}
