import {
  applyManagedSubscriptions,
  formatManagedSubscriptionPlan,
  planManagedSubscriptions,
  prepareManagedSubscriptions,
  verifyManagedSubscriptions,
  type ManagedSubscriptionOptions,
  type ManagedSubscriptionPhase,
} from './fleet'

export function managedSubscriptionUsage(): string {
  return [
    'usage: pnpm subscription:fleet <plan|prepare|apply|verify> --manifest <file> --subscription <name> [--subscription <name> ...] [options]',
    '',
    'options:',
    '  --manifest <file>       read the private managed-subscription manifest',
    '  --subscription <name>   select a managed subscription, repeatable',
    '  -y, --yes               apply production changes without prompting',
    '  -h, --help              show this help',
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseManagedSubscriptionArgs(argv: string[]): ManagedSubscriptionOptions {
  const phase = argv[0]
  if (phase === '--help' || phase === '-h') throw new Error(managedSubscriptionUsage())
  if (!phase || !['plan', 'prepare', 'apply', 'verify'].includes(phase)) {
    throw new Error(managedSubscriptionUsage())
  }
  let manifest: string | undefined
  const subscriptions: string[] = []
  let yes = false

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--manifest') {
      if (manifest !== undefined) throw new Error('--manifest may only be supplied once')
      manifest = optionValue(argv, index, arg)
      index += 1
    } else if (arg === '--subscription') {
      const name = optionValue(argv, index, arg)
      if (subscriptions.includes(name)) throw new Error(`--subscription supplied more than once: ${name}`)
      subscriptions.push(name)
      index += 1
    } else if (arg === '--yes' || arg === '-y') {
      yes = true
    } else if (arg === '--help' || arg === '-h') {
      throw new Error(managedSubscriptionUsage())
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  if (!manifest) throw new Error('--manifest is required')
  if (subscriptions.length === 0) throw new Error('at least one --subscription is required')
  if (yes && phase !== 'apply') throw new Error('-y is only valid with apply')
  return {
    phase: phase as ManagedSubscriptionPhase,
    manifest,
    subscriptions,
    yes,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(managedSubscriptionUsage())
    return
  }
  const options: ManagedSubscriptionOptions = {
    ...parseManagedSubscriptionArgs(argv),
    progress: (message) => console.error(`PROGRESS ${message}`),
  }
  if (options.phase === 'plan') {
    const plan = await planManagedSubscriptions(options)
    console.log(formatManagedSubscriptionPlan(plan))
    if (plan.blockers.length > 0) process.exitCode = 1
    return
  }
  if (options.phase === 'prepare') {
    const result = await prepareManagedSubscriptions(options)
    console.log(`Prepared managed subscriptions: ${result.subscriptions.length}`)
    console.log(`Local route additions: ${result.routeAdditions}`)
    console.log(`Local route updates: ${result.routeUpdates}`)
    console.log(`Local HMAC additions: ${result.localSecretAdditions}`)
    return
  }
  if (options.phase === 'apply') {
    const plan = await planManagedSubscriptions(options)
    console.log(formatManagedSubscriptionPlan(plan))
    const result = await applyManagedSubscriptions(options)
    console.log(`Applied production changes: ${result.applied ? 'yes' : 'no'}`)
    console.log(`Installed Hookrelay Worker secrets: ${result.receiverSecretsInstalled}`)
    console.log(`Installed sender Worker secrets: ${result.senderSecretsInstalled}`)
    console.log(`Wrote production subscription routes: ${result.subscriptionRoutesWritten}`)
    console.log(`Wrote production sink routes: ${result.sinkRoutesWritten}`)
    return
  }
  const result = await verifyManagedSubscriptions(options)
  console.log(`Verified managed subscriptions: ${result.subscriptions.length}`)
  console.log(`Verified authenticated requests: ${result.verifiedRequests}`)
  for (const issue of result.issues) console.log(`ISSUE ${issue}`)
  if (result.issues.length > 0) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
