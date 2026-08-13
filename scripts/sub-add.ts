import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import { hashSubscriptionSlug } from '../src/lib/subscription'
import { discoverWorkerBaseUrl } from './cloudflare-domains'
import {
  parseGitHubEventSelection,
  type GitHubEventSelection,
} from './github-events'
import { validateGitHubRepo } from './github-repository'
import { getSourceProfile } from './subscription-sources'
import {
  addDevVar,
  confirm,
  envSegment,
  prepareProduction,
  readOptionalText,
  runProcess,
  type SecretValue,
  writePrivateText,
  writeText,
} from './setup'
import { parseRoutes } from './sync'

export { validateGitHubRepo } from './github-repository'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const DEFAULT_GITHUB_EVENT_SELECTION = 'push'
const GITHUB_PROFILE_REFERENCE = 'docs/github-event-profiles.md'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })
const SUB_ADD_OPTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '-s': '--sink',
  '-b': '--base-url',
  '-r': '--repo',
  '-e': '--events',
  '-y': '--yes',
  '-h': '--help',
})

export interface SubAddOptions {
  name: string
  source: string
  sinks: string[]
  baseUrl?: string
  repo?: string
  githubEvents: GitHubEventSelection
  yes: boolean
}

interface GeneratedValues {
  slug?: string
  senderSecret?: string
}

interface NewSubscriptionConfig {
  name: string
  source: string
  slugHash: string
  enabled: boolean
  sinks: string[]
  auth?: {
    scheme: string
    secretEnv: string
  }
  setup?: {
    github: {
      repo: string
      eventProfiles: string[]
    }
  }
}

export interface PreparedSubscription {
  routesText: string
  devVarsText: string
  webhookUrl: string
  rawSlug: string
  slugSecretName: string
  senderSecret: SecretValue | null
  subscription: NewSubscriptionConfig
}

export function subAddUsage(): string {
  return [
    'usage: pnpm sub:add <name> <source> [options]',
    '',
    'options:',
    '  -s, --sink <name>       select a sink, repeatable',
    '  -b, --base-url <url>    set the Hookrelay base URL',
    '  -r, --repo <owner/repo> GitHub repository target',
    '  -e, --events <profiles> comma-separated GitHub profiles (default: push)',
    '  -y, --yes               apply remote changes without prompts',
    '  -h, --help              show this help',
    '',
    `GitHub profiles: ${GITHUB_PROFILE_REFERENCE}`,
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseSubAddArgs(argv: string[]): SubAddOptions {
  const positional: string[] = []
  const sinks: string[] = []
  let baseUrl: string | undefined
  let repo: string | undefined
  let githubEvents = parseGitHubEventSelection(DEFAULT_GITHUB_EVENT_SELECTION)
  let githubEventsSpecified = false
  let yes = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    const option = SUB_ADD_OPTION_ALIASES[arg] ?? arg
    if (option === '--sink') {
      sinks.push(optionValue(argv, i, arg))
      i += 1
    } else if (option === '--base-url') {
      if (baseUrl !== undefined) throw new Error('--base-url may only be supplied once')
      baseUrl = optionValue(argv, i, arg)
      i += 1
    } else if (option === '--repo') {
      if (repo !== undefined) throw new Error('--repo may only be supplied once')
      repo = optionValue(argv, i, arg)
      i += 1
    } else if (option === '--events') {
      if (githubEventsSpecified) throw new Error('--events may only be supplied once')
      const value = optionValue(argv, i, arg)
      githubEvents = parseGitHubEventSelection(value)
      githubEventsSpecified = true
      i += 1
    } else if (option === '--yes') {
      yes = true
    } else if (option === '--help') {
      throw new Error(subAddUsage())
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length !== 2) throw new Error(subAddUsage())
  const [name, source] = positional as [string, string]
  if (source === 'github') {
    if (!repo) throw new Error('GitHub subscriptions require --repo <owner/repo>')
    validateGitHubRepo(repo)
  } else if (repo || githubEventsSpecified) {
    throw new Error('--repo and --events are only valid for GitHub subscriptions')
  }

  return { name, source, sinks, baseUrl, repo, githubEvents, yes }
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('base URL must use https')
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('base URL must contain only scheme and host')
  }
  return url.origin
}

export async function resolveSubscriptionBaseUrl(
  routesText: string,
  explicitBaseUrl: string | undefined,
  discover: () => Promise<string> = discoverWorkerBaseUrl,
): Promise<string> {
  if (explicitBaseUrl) return normalizeBaseUrl(explicitBaseUrl)
  const savedBaseUrl = parseRoutes(routesText).baseUrl
  if (savedBaseUrl) return normalizeBaseUrl(savedBaseUrl)
  return normalizeBaseUrl(await discover())
}

export function selectSinks(configuredNames: string[], requestedNames: string[]): string[] {
  if (configuredNames.length === 0) throw new Error('routes.jsonc has no sinks; add a sink first')
  if (requestedNames.length === 0) {
    if (configuredNames.length === 1) return [configuredNames[0]!]
    throw new Error(`multiple sinks are configured; select one or more with --sink (${configuredNames.join(', ')})`)
  }

  const selected = new Set<string>()
  for (const name of requestedNames) {
    if (!configuredNames.includes(name)) throw new Error(`unknown sink: ${name}`)
    if (selected.has(name)) throw new Error(`sink selected more than once: ${name}`)
    selected.add(name)
  }
  return [...selected]
}

function updateRoutesText(text: string, baseUrl: string, subscription: NewSubscriptionConfig): string {
  let updated = text
  const parsed = parseRoutes(text)
  if (parsed.baseUrl !== baseUrl) {
    updated = applyEdits(updated, modify(updated, ['baseUrl'], baseUrl, { formattingOptions: FORMATTING_OPTIONS }))
  }
  updated = applyEdits(
    updated,
    modify(updated, ['subs', -1], subscription, {
      isArrayInsertion: true,
      formattingOptions: FORMATTING_OPTIONS,
    }),
  )
  if (!updated.endsWith('\n')) updated += '\n'
  parseRoutes(updated)
  return updated
}

export async function prepareSubscription(
  routesText: string,
  devVarsText: string,
  options: SubAddOptions,
  generated: GeneratedValues = {},
): Promise<PreparedSubscription> {
  const routes = parseRoutes(routesText)
  const profile = getSourceProfile(options.source)
  if (!profile) throw new Error(`unknown source: ${options.source}`)
  if (routes.subs.some((sub) => sub.name === options.name)) {
    throw new Error(`subscription already exists: ${options.name}`)
  }

  const sinks = selectSinks(routes.sinks.map((sink) => sink.name), options.sinks)
  const baseUrlValue = options.baseUrl ?? routes.baseUrl
  if (!baseUrlValue) throw new Error('routes.jsonc has no baseUrl; pass --base-url <url>')
  const baseUrl = normalizeBaseUrl(baseUrlValue)
  const rawSlug = generated.slug ?? randomBytes(16).toString('base64url')
  const slugHash = await hashSubscriptionSlug(rawSlug)
  if (routes.subs.some((sub) => sub.slugHash === slugHash)) {
    throw new Error('generated subscription slug collides with an existing subscription')
  }
  const label = envSegment(options.name)
  const slugSecretName = `SUB_${label}_SLUG`

  let senderSecret: SecretValue | null = null
  let auth: NewSubscriptionConfig['auth']
  if (profile.senderAuth) {
    const secretEnv = `${profile.senderAuth.secretEnvPrefix}_${label}`
    if (routes.subs.some((sub) => sub.auth?.secretEnv === secretEnv)) {
      throw new Error(`sender secret name is already referenced: ${secretEnv}`)
    }
    senderSecret = {
      name: secretEnv,
      value: generated.senderSecret ?? randomBytes(32).toString('hex'),
    }
    auth = { scheme: profile.senderAuth.scheme, secretEnv }
  }

  const subscription: NewSubscriptionConfig = {
    name: options.name,
    source: options.source,
    slugHash,
    enabled: true,
    sinks,
    ...(auth ? { auth } : {}),
    ...(options.source === 'github' && options.repo
      ? {
          setup: {
            github: {
              repo: options.repo,
              eventProfiles: [...options.githubEvents.names],
            },
          },
        }
      : {}),
  }
  const webhookUrl = `${baseUrl}/hook/${options.source}/${rawSlug}`
  const updatedRoutesText = updateRoutesText(routesText, baseUrl, subscription)
  const updatedDevVarsText = senderSecret
    ? addDevVar(devVarsText, senderSecret.name, senderSecret.value)
    : devVarsText

  return {
    routesText: updatedRoutesText,
    devVarsText: updatedDevVarsText,
    webhookUrl,
    rawSlug,
    slugSecretName,
    senderSecret,
    subscription,
  }
}

export function githubHookPayload(
  webhookUrl: string,
  secret: string,
  selection: GitHubEventSelection,
): Record<string, unknown> | null {
  if (!selection.events) return null
  return {
    name: 'web',
    active: true,
    events: [...selection.events],
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret,
      insecure_ssl: '0',
    },
  }
}

async function assertGitHubHookAbsent(repo: string, webhookUrl: string): Promise<void> {
  const output = await runProcess('gh', ['api', `repos/${repo}/hooks`], { captureStdout: true })
  const hooks = JSON.parse(output) as Array<{ config?: { url?: string } }>
  if (hooks.some((hook) => hook.config?.url === webhookUrl)) {
    throw new Error(`GitHub webhook already exists for this URL in ${repo}`)
  }
}

async function createGitHubHook(
  repo: string,
  webhookUrl: string,
  secret: string,
  selection: GitHubEventSelection,
): Promise<number> {
  const payload = githubHookPayload(webhookUrl, secret, selection)
  if (!payload) throw new Error('manual GitHub event selection cannot create a webhook')
  await assertGitHubHookAbsent(repo, webhookUrl)
  const output = await runProcess('gh', ['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'], {
    input: JSON.stringify(payload),
    captureStdout: true,
  })
  const created = JSON.parse(output) as { id?: number }
  if (!created.id) throw new Error('GitHub created the webhook without returning an id')
  return created.id
}

function printPrepared(options: SubAddOptions, prepared: PreparedSubscription): void {
  console.log(`Prepared subscription ${options.name}`)
  console.log('')
  console.log('Save in your secret store:')
  console.log(`  ${prepared.slugSecretName}=${prepared.rawSlug}`)
  if (prepared.senderSecret) console.log(`  ${prepared.senderSecret.name}=${prepared.senderSecret.value}`)
  console.log('')
  console.log(`Webhook URL: ${prepared.webhookUrl}`)

  if (options.source === 'github') {
    console.log(`GitHub repository: ${options.repo}`)
    console.log('Content type: application/json')
    console.log('SSL verification: enabled')
    console.log(`Event profiles: ${options.githubEvents.names.join(', ')}`)
    if (options.githubEvents.events) console.log(`Events: ${options.githubEvents.events.join(', ')}`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(subAddUsage())
    return
  }
  const options = parseSubAddArgs(argv)
  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const baseUrl = await resolveSubscriptionBaseUrl(routesText, options.baseUrl)
  const resolvedOptions = { ...options, baseUrl }
  const prepared = await prepareSubscription(routesText, devVarsText, resolvedOptions)

  await writeText(routesPath, prepared.routesText)
  if (prepared.senderSecret) await writePrivateText(devVarsPath, prepared.devVarsText)
  printPrepared(resolvedOptions, prepared)

  const production = await prepareProduction(prepared.senderSecret, options.yes)
  if (production === 'local-only') {
    console.log('')
    if (prepared.senderSecret) {
      console.log(`Production was not changed; install ${prepared.senderSecret.name} in Wrangler, then run pnpm sync and pnpm sync -y`)
    } else {
      console.log('Production was not changed; run pnpm sync and pnpm sync -y')
    }
    if (options.source === 'github' && options.githubEvents.kind !== 'manual') {
      console.log('After the route is live, create the GitHub webhook manually with the fields printed above')
    }
    return
  }
  if (production === 'previewed') {
    console.log('The KV route was not changed; run pnpm sync -y to apply it')
    if (options.source === 'github' && options.githubEvents.kind !== 'manual') {
      console.log('After the route is live, create the GitHub webhook manually with the fields printed above')
    }
    return
  }

  if (options.source !== 'github' || options.githubEvents.kind === 'manual') {
    if (options.source === 'github') {
      console.log('Create the GitHub webhook with the fields printed above and choose events manually')
    }
    return
  }

  if (!prepared.senderSecret || !options.repo) throw new Error('GitHub setup is missing sender authentication or repository')
  const selectedEvents = options.githubEvents.events!
  const selectionLabel = options.githubEvents.names.join(',')
  const create = options.yes || await confirm(
    `Create the GitHub webhook in ${options.repo} with ${selectionLabel} (${selectedEvents.length === 1 ? selectedEvents[0] : `${selectedEvents.length} events`})?`,
  )
  if (!create) {
    console.log('GitHub was not changed; create the webhook manually with the fields printed above')
    return
  }

  const hookId = await createGitHubHook(
    options.repo,
    prepared.webhookUrl,
    prepared.senderSecret.value,
    options.githubEvents,
  )
  console.log(`Created GitHub webhook ${hookId} in ${options.repo}`)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
