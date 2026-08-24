import {
  formatGitHubFleetPlan,
  planGitHubFleet,
  prepareGitHubFleet,
  type GitHubFleetOptions,
  type GitHubFleetPhase,
} from './fleet'
import { parseGitHubFleetProfiles, type GitHubFleetProfileName } from './model'

const DEFAULT_SECRET_LIMIT = 64

export function githubFleetUsage(): string {
  return [
    'usage: pnpm github:fleet <plan|prepare|apply|verify> --root <directory> [--root <directory> ...] --manifest <file> [options]',
    '',
    'options:',
    '  --root <directory>    discover direct-child repositories, repeatable',
    '  --repo <owner/repo>    select a new repository, repeatable',
    '  --profiles <names>     save a comma-separated profile subset for selected new repositories',
    '  --include-private       admit private repositories selected with --repo',
    '  --retire               operate on selected managed repositories as retirements',
    '  --rotate-hmac          replace selected repository HMACs through every fleet phase',
    `  --secret-limit <count> Worker variable and secret limit (default: ${DEFAULT_SECRET_LIMIT})`,
    '  -y, --yes              apply production changes without prompts',
    '  -h, --help             show this help',
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseGitHubFleetArgs(argv: string[]): GitHubFleetOptions {
  const phase = argv[0]
  if (phase === '--help' || phase === '-h') throw new Error(githubFleetUsage())
  if (!phase || !['plan', 'prepare', 'apply', 'verify'].includes(phase)) throw new Error(githubFleetUsage())
  const roots: string[] = []
  let manifest: string | undefined
  const repositories: string[] = []
  let includePrivate = false
  let secretLimit = DEFAULT_SECRET_LIMIT
  let yes = false
  let retire = false
  let rotateHmac = false
  let profiles: GitHubFleetProfileName[] | undefined

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--root') {
      const root = optionValue(argv, index, arg)
      if (roots.includes(root)) throw new Error(`--root supplied more than once: ${root}`)
      roots.push(root)
      index += 1
    } else if (arg === '--manifest') {
      if (manifest !== undefined) throw new Error('--manifest may only be supplied once')
      manifest = optionValue(argv, index, arg)
      index += 1
    } else if (arg === '--repo') {
      const repo = optionValue(argv, index, arg)
      if (repositories.includes(repo)) throw new Error(`--repo supplied more than once: ${repo}`)
      repositories.push(repo)
      index += 1
    } else if (arg === '--include-private') {
      includePrivate = true
    } else if (arg === '--profiles') {
      if (profiles !== undefined) throw new Error('--profiles may only be supplied once')
      profiles = parseGitHubFleetProfiles(optionValue(argv, index, arg))
      index += 1
    } else if (arg === '--retire') {
      retire = true
    } else if (arg === '--rotate-hmac') {
      rotateHmac = true
    } else if (arg === '--secret-limit') {
      const raw = optionValue(argv, index, arg)
      secretLimit = Number(raw)
      if (!Number.isSafeInteger(secretLimit) || secretLimit < 1) {
        throw new Error('--secret-limit must be a positive integer')
      }
      index += 1
    } else if (arg === '--yes' || arg === '-y') {
      yes = true
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(githubFleetUsage())
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (roots.length === 0) throw new Error('--root is required')
  if (!manifest) throw new Error('--manifest is required')
  if (includePrivate && repositories.length === 0) throw new Error('--include-private requires at least one --repo')
  if (profiles && repositories.length === 0) throw new Error('--profiles requires at least one --repo')
  if (retire && repositories.length === 0) throw new Error('--retire requires at least one --repo')
  if (rotateHmac && repositories.length === 0) throw new Error('--rotate-hmac requires at least one --repo')
  if (retire && profiles) throw new Error('--profiles cannot be combined with --retire')
  if (retire && rotateHmac) throw new Error('--rotate-hmac cannot be combined with --retire')
  if (yes && phase !== 'apply') throw new Error('-y is only valid with apply')
  return {
    phase: phase as GitHubFleetPhase,
    roots,
    manifest,
    repositories,
    includePrivate,
    secretLimit,
    yes,
    retire,
    rotateHmac,
    profiles,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(githubFleetUsage())
    return
  }
  const options: GitHubFleetOptions = {
    ...parseGitHubFleetArgs(argv),
    progress: (message) => console.error(`PROGRESS ${message}`),
  }
  if (options.retire) {
    const {
      applyGitHubFleetRetirement,
      formatGitHubFleetRetirementPlan,
      planGitHubFleetRetirement,
      prepareGitHubFleetRetirement,
      verifyGitHubFleetRetirement,
    } = await import('./retirement')
    if (options.phase === 'plan') {
      const plan = await planGitHubFleetRetirement(options)
      console.log(formatGitHubFleetRetirementPlan(plan))
      if (plan.blockers.length > 0) process.exitCode = 1
      return
    }
    if (options.phase === 'prepare') {
      const result = await prepareGitHubFleetRetirement(options)
      console.log(`Prepared repository retirements: ${result.repositories.length}`)
      console.log(`Disabled local subscriptions: ${result.disabledSubscriptions}`)
      return
    }
    if (options.phase === 'apply') {
      const plan = await planGitHubFleetRetirement(options)
      console.log(formatGitHubFleetRetirementPlan(plan))
      const result = await applyGitHubFleetRetirement(options)
      console.log(`Deleted GitHub hooks: ${result.deletedHooks}`)
      console.log(`Deleted subscription routes: ${result.deletedRoutes}`)
      console.log(`Deleted repository HMACs: ${result.deletedSecrets}`)
      return
    }
    const result = await verifyGitHubFleetRetirement(options)
    console.log(`Verified retired repositories: ${result.repositories.length}`)
    for (const issue of result.issues) console.log(`ISSUE ${issue}`)
    if (result.issues.length > 0) process.exitCode = 1
    return
  }
  if (options.phase === 'plan') {
    const plan = await planGitHubFleet(options)
    console.log(formatGitHubFleetPlan(plan))
    if (plan.blockers.length > 0) process.exitCode = 1
    return
  }
  if (options.phase === 'prepare') {
    const result = await prepareGitHubFleet(options)
    console.log(`Prepared ${result.repositories.length} repositories`)
    console.log(`Manifest additions: ${result.manifestAdditions}`)
    console.log(`Local secret additions: ${result.devVarAdditions}`)
    console.log(`Local secret rotations: ${result.devVarRotations}`)
    console.log(`Subscription additions: ${result.subscriptionAdditions}`)
    return
  }
  const { applyGitHubFleet, verifyGitHubFleet } = await import('./reconcile')
  if (options.phase === 'apply') {
    const result = await applyGitHubFleet(options)
    console.log(`Installed repository HMACs: ${result.installedSecrets}`)
    console.log(`Rotated repository HMACs: ${result.rotatedSecrets}`)
    console.log(`Reconciled GitHub hooks: ${result.reconciledHooks}`)
    return
  }
  const result = await verifyGitHubFleet(options)
  console.log(`Verified repositories: ${result.repositories.length}`)
  console.log(`Verified GitHub hooks: ${result.verifiedHooks}`)
  for (const issue of result.issues) console.log(`ISSUE ${issue}`)
  if (result.issues.length > 0) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
