import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { z } from 'zod'

const FULL_TRAFFIC_PERCENTAGE = 100
const MAIN_REF = 'refs/remotes/origin/main'
const WORKFLOW_REF = 'refs/heads/main'
const FULL_SHA = /^[a-f0-9]{40}$/
const PACKAGE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_COMMAND_BYTES = 2 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 30_000
const releaseSchema = z.object({ tag_name: z.string().regex(RELEASE_TAG), draft: z.boolean(), prerelease: z.boolean() })
const packageSchema = z.object({ version: z.string().regex(PACKAGE_VERSION) })
const receiptSchema = z.object({ type: z.literal('deploy'), version: z.literal(1), worker_name: z.string(), version_id: z.uuid() })
const deploymentSchema = z.object({
  id: z.uuid(),
  created_on: z.iso.datetime({ offset: true }),
  versions: z.array(z.object({ version_id: z.uuid(), percentage: z.number().min(0).max(FULL_TRAFFIC_PERCENTAGE) })).min(1),
})

class DeploymentError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message) }
}

interface SelectionInput {
  mode: string
  revision: string
  workflowRef: string
  eventName: string
}
interface SelectionDependencies {
  cwd?: string
  readRelease?: (tag?: string) => Promise<unknown>
}

function command(executable: string, args: string[], cwd: string): string {
  try {
    return execFileSync(executable, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_COMMAND_BYTES, timeout: COMMAND_TIMEOUT_MS,
    }).trim()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new DeploymentError(`Required dependency is missing: ${executable}`, 3)
    throw new DeploymentError(`Deployment selection could not complete ${executable}; verify repository access and the requested revision`)
  }
}

async function readGitHubRelease(tag?: string): Promise<unknown> {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new DeploymentError('GITHUB_REPOSITORY is required')
  const endpoint = tag ? `tags/${encodeURIComponent(tag)}` : 'latest'
  return JSON.parse(command('gh', ['api', `repos/${repository}/releases/${endpoint}`], process.cwd()))
}

export async function selectDeployment(input: SelectionInput, dependencies: SelectionDependencies = {}) {
  if (input.workflowRef !== WORKFLOW_REF || input.eventName !== 'workflow_dispatch') {
    throw new DeploymentError('Deployment must be dispatched from main', 2)
  }
  const cwd = dependencies.cwd ?? process.cwd()
  const git = (...args: string[]) => command('git', args, cwd)
  let selection = input.revision
  if (input.mode === 'main-commit') {
    if (!FULL_SHA.test(selection)) throw new DeploymentError('Main-commit deployment requires a full lowercase commit SHA', 2)
    const mainSha = git('rev-parse', '--verify', `${MAIN_REF}^{commit}`)
    try { git('merge-base', '--is-ancestor', selection, mainSha) }
    catch { throw new DeploymentError('The selected commit must be reachable from main') }
  } else if (input.mode === 'release') {
    if (selection && !RELEASE_TAG.test(selection)) throw new DeploymentError('Release deployment requires a v-prefixed semantic version tag', 2)
    const release = releaseSchema.safeParse(await (dependencies.readRelease ?? readGitHubRelease)(selection || undefined))
    if (!release.success || release.data.draft || (!selection && release.data.prerelease) || (selection && release.data.tag_name !== selection)) {
      throw new DeploymentError('Select a published release; the default requires a published stable release')
    }
    selection = release.data.tag_name
  } else {
    throw new DeploymentError('Deployment mode must be release or main-commit', 2)
  }
  const ref = input.mode === 'release' ? `refs/tags/${selection}` : selection
  const sha = git('rev-parse', '--verify', `${ref}^{commit}`)
  if (input.mode === 'main-commit' && sha !== selection) throw new DeploymentError('Select a commit SHA, rather than a tag object')
  if (!FULL_SHA.test(sha)) throw new DeploymentError('Could not resolve a full deployment commit SHA')
  const pkg = packageSchema.safeParse(JSON.parse(git('show', `${sha}:package.json`)))
  if (!pkg.success || (input.mode === 'release' && selection !== `v${pkg.data.version}`)) {
    throw new DeploymentError('Deployment tag and package version must match')
  }
  return { mode: input.mode, selection, sha, packageVersion: pkg.data.version }
}

export function verifyDeployment(configText: string, outputText: string, deploymentsText: string) {
  const errors: ParseError[] = []
  const config = z.object({ name: z.string().regex(/^[a-zA-Z0-9_-]+$/) }).safeParse(parseJsonc(configText, errors, { allowTrailingComma: true }))
  if (errors.length || !config.success) throw new DeploymentError('Invalid deployment Worker name in Wrangler configuration')
  let records: unknown[]
  let history: unknown
  try {
    records = outputText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
    history = JSON.parse(deploymentsText)
  } catch { throw new DeploymentError('Deployment receipt or provider history is not valid JSON') }
  const receipts = records.filter(record => record !== null && typeof record === 'object' && 'type' in record && record.type === 'deploy')
  const receipt = receipts.length === 1 ? receiptSchema.safeParse(receipts[0]) : undefined
  const deployments = z.array(deploymentSchema).min(1).safeParse(history)
  if (!receipt?.success || receipt.data.worker_name !== config.data.name || !deployments.success) {
    throw new DeploymentError('Deployment receipt or provider history is missing, inconsistent, or unsupported')
  }
  const ordered = deployments.data.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  const latest = ordered[0]!
  if (ordered[1] && Date.parse(latest.created_on) === Date.parse(ordered[1].created_on)) {
    throw new DeploymentError('Provider deployment ordering is ambiguous')
  }
  if (latest.versions.length !== 1 || latest.versions[0]!.percentage !== FULL_TRAFFIC_PERCENTAGE || latest.versions[0]!.version_id !== receipt.data.version_id) {
    throw new DeploymentError('Active provider deployment does not serve the expected version at 100 percent')
  }
  return { workerName: config.data.name, versionId: receipt.data.version_id, deploymentId: latest.id }
}

const HELP = `Usage: tsx scripts/deployment.ts <select|verify> [options]

Internal manual-deployment workflow helper (Node.js 22, git, gh)
  select --mode <release|main-commit> [--revision <tag|full-SHA>]
    Requires GITHUB_EVENT_NAME=workflow_dispatch and GITHUB_REF=refs/heads/main
    Release mode uses GH_TOKEN and GITHUB_REPOSITORY; omitted tag uses latest stable
    Git checkout must contain origin/main and release tags
    Validated outputs append to GITHUB_OUTPUT when configured
  verify --config <wrangler.jsonc> --output <Wrangler NDJSON> --deployments <JSON>
    Checks one deploy-v1 receipt against the latest provider deployment
    Safe identifiers append to GITHUB_STEP_SUMMARY when configured
  -h, --help  Show this help

Exit status: 0 success, 1 operation failed, 2 invalid arguments, 3 missing dependency
`

async function main() {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({ allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, mode: { type: 'string' }, revision: { type: 'string' },
      config: { type: 'string' }, output: { type: 'string' }, deployments: { type: 'string' },
    } })
  } catch { process.stderr.write(HELP); process.exitCode = 2; return }
  const { values, positionals } = args
  if (values.help) { process.stdout.write(HELP); return }
  if (positionals.length !== 1 || !['select', 'verify'].includes(positionals[0]!)) {
    process.stderr.write(HELP); process.exitCode = 2; return
  }
  if (positionals[0] === 'select') {
    if (values.config || values.output || values.deployments) { process.stderr.write(HELP); process.exitCode = 2; return }
    const result = await selectDeployment({
      mode: String(values.mode ?? 'release'), revision: String(values.revision ?? ''),
      workflowRef: process.env.GITHUB_REF ?? '', eventName: process.env.GITHUB_EVENT_NAME ?? '',
    })
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha=${result.sha}\nselection=${result.selection}\npackage_version=${result.packageVersion}\n`)
    console.log(JSON.stringify(result))
  } else {
    if (!values.config || !values.output || !values.deployments || values.mode || values.revision) {
      process.stderr.write(HELP); process.exitCode = 2; return
    }
    const result = verifyDeployment(...[values.config, values.output, values.deployments].map(path => readFileSync(resolve(String(path)), 'utf8')) as [string, string, string])
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nProvider verification: matched\n\nWorker: ${result.workerName}\n\nVersion: ${result.versionId}\n\nDeployment: ${result.deploymentId}\n\nRuntime health and configuration sync: operator verification required\n`)
    console.log(JSON.stringify(result))
  }
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof DeploymentError ? error.message : 'Deployment selection or verification failed; check the release metadata, local files, and provider state')
  process.exitCode = error instanceof DeploymentError ? error.exitCode : 1
})
