import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  parseGitHubEventSelection,
  type GitHubEventSelection,
} from './github-events'
import {
  listGitHubRepositoryHooks,
  requireMatchingGitHubRepositoryHook,
  sameGitHubEvents,
  updateGitHubRepositoryHookEvents,
  validateGitHubRepo,
} from './github-repository'
import { confirm, getDevVar, readOptionalText } from './setup'
import { parseRoutes } from './sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const GITHUB_AUTH_SCHEME = 'github-sha256'
const GITHUB_PROFILE_REFERENCE = 'docs/github-event-profiles.md'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })
const SUB_EVENTS_OPTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '-e': '--events',
  '-y': '--yes',
  '-h': '--help',
})

export interface SubEventsOptions {
  name: string
  githubEvents?: GitHubEventSelection
  yes: boolean
}

export interface PreparedSubEvents {
  routesText: string
  repo: string
  slugHash: string
  secretEnv: string | null
  previousProfileNames: readonly string[]
  githubEvents: GitHubEventSelection
  routesChanged: boolean
}

export function subEventsUsage(): string {
  return [
    'usage: pnpm sub:events <subscription-name> [-e <profiles>] [-y]',
    '',
    'options:',
    '  -e, --events <profiles> replace the saved comma-separated GitHub profiles',
    '  -y, --yes              apply the GitHub webhook change without prompting',
    '  -h, --help             show this help',
    '',
    'Omit --events to reconcile profiles already edited in routes.jsonc.',
    `GitHub profiles: ${GITHUB_PROFILE_REFERENCE}`,
  ].join('\n')
}

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

export function parseSubEventsArgs(argv: string[]): SubEventsOptions {
  const positional: string[] = []
  let githubEvents: GitHubEventSelection | undefined
  let yes = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const option = SUB_EVENTS_OPTION_ALIASES[arg] ?? arg
    if (option === '--events') {
      if (githubEvents) throw new Error('--events may only be supplied once')
      githubEvents = parseGitHubEventSelection(optionValue(argv, index, arg))
      index += 1
    } else if (option === '--yes') {
      yes = true
    } else if (option === '--help') {
      throw new Error(subEventsUsage())
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length !== 1) throw new Error(subEventsUsage())
  return { name: positional[0]!, githubEvents, yes }
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index])
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

export function prepareSubEvents(
  routesText: string,
  name: string,
  requestedEvents?: GitHubEventSelection,
): PreparedSubEvents {
  const routes = parseRoutes(routesText)
  const matches = routes.subs
    .map((sub, index) => ({ sub, index }))
    .filter(({ sub }) => sub.name === name)
  if (matches.length === 0) throw new Error(`subscription does not exist: ${name}`)
  if (matches.length > 1) throw new Error(`subscription is declared more than once: ${name}`)

  const { sub, index } = matches[0]!
  if (sub.source !== 'github') throw new Error(`subscription is not a GitHub subscription: ${name}`)
  const github = sub.setup?.github
  if (!github) throw new Error(`subscription has no setup.github metadata: ${name}`)
  validateGitHubRepo(github.repo)

  const previousProfileNames = github.eventProfiles
  const githubEvents = requestedEvents ?? parseGitHubEventSelection(previousProfileNames.join(','))
  const secretEnv = sub.auth?.scheme === GITHUB_AUTH_SCHEME ? sub.auth.secretEnv : null
  if (githubEvents.kind !== 'manual' && !secretEnv) {
    throw new Error(`subscription has no ${GITHUB_AUTH_SCHEME} sender secret: ${name}`)
  }
  const routesChanged = !sameStrings(previousProfileNames, githubEvents.names)
  const updated = routesChanged
    ? withTrailingNewline(applyEdits(
        routesText,
        modify(routesText, ['subs', index, 'setup', 'github', 'eventProfiles'], [...githubEvents.names], {
          formattingOptions: FORMATTING_OPTIONS,
        }),
      ))
    : routesText
  parseRoutes(updated)

  return {
    routesText: updated,
    repo: github.repo,
    slugHash: sub.slugHash,
    secretEnv,
    previousProfileNames,
    githubEvents,
    routesChanged,
  }
}

function profileLabel(names: readonly string[]): string {
  return names.join(',')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(subEventsUsage())
    return
  }
  const options = parseSubEventsArgs(argv)
  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  const routesText = await readFile(routesPath, 'utf8')
  const prepared = prepareSubEvents(routesText, options.name, options.githubEvents)

  if (prepared.routesChanged) {
    await writeFile(routesPath, prepared.routesText, 'utf8')
    console.log(
      `Saved event profiles for ${options.name}: ${profileLabel(prepared.previousProfileNames)} -> ${profileLabel(prepared.githubEvents.names)}`,
    )
  } else {
    console.log(`Using saved event profiles for ${options.name}: ${profileLabel(prepared.githubEvents.names)}`)
  }

  if (prepared.githubEvents.kind === 'manual') {
    console.log('GitHub was not changed because the manual preset leaves webhook events user-managed')
    return
  }

  const hooks = await listGitHubRepositoryHooks(prepared.repo)
  const hook = await requireMatchingGitHubRepositoryHook(
    hooks,
    prepared.slugHash,
    options.name,
    prepared.repo,
  )
  const desiredEvents = prepared.githubEvents.events!
  if (sameGitHubEvents(hook.events, desiredEvents)) {
    console.log(`GitHub webhook events already match in ${prepared.repo}`)
    return
  }

  const secretEnv = prepared.secretEnv!
  const webhookSecret = getDevVar(await readOptionalText(devVarsPath), secretEnv)
  if (webhookSecret === null) {
    throw new Error(`${secretEnv} is missing from .dev.vars; GitHub requires the existing secret when replacing webhook events`)
  }

  console.log('Plan:')
  console.log(`  UPDATE GitHub webhook events for ${options.name} in ${prepared.repo}`)
  if (!options.yes && !(await confirm(`Apply ${profileLabel(prepared.githubEvents.names)} to the GitHub webhook?`))) {
    console.log('GitHub was not changed; re-run with -y to apply the saved event profiles')
    return
  }

  await updateGitHubRepositoryHookEvents(prepared.repo, hook, desiredEvents, webhookSecret)
  console.log(`Updated GitHub webhook events in ${prepared.repo}`)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
