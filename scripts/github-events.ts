import type { SubscriptionFilter } from '../src/types'

const events = <T extends readonly string[]>(...values: T): Readonly<T> => Object.freeze(values)

export const GITHUB_ACTIVITY_EVENTS = events('push', 'workflow_run', 'pull_request')

const GITHUB_ACTIVITY_PUSH_DELIVERY_TYPES = events(
  'push.created',
  'push.updated',
  'push.deleted',
)

export const GITHUB_ALERT_EVENTS = events(
  'code_scanning_alert',
  'dependabot_alert',
  'secret_scanning_alert',
)

export const GITHUB_EVENT_PROFILES = Object.freeze({
  access: events('deploy_key', 'member', 'team_add'),
  activity: GITHUB_ACTIVITY_EVENTS,
  alerts: GITHUB_ALERT_EVENTS,
  branches: events('create', 'delete'),
  checks: events('check_run', 'check_suite', 'status'),
  'commit-comments': events('commit_comment'),
  deployments: events('deployment', 'deployment_status', 'page_build'),
  discussions: events('discussion', 'discussion_comment'),
  forks: events('fork'),
  issues: events('issue_comment', 'issue_dependencies', 'issues', 'label', 'milestone', 'sub_issues'),
  packages: events('package', 'registry_package'),
  projects: events('project', 'project_card', 'project_column'),
  'pull-requests': events(
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'pull_request_review_thread',
  ),
  push: events('push'),
  releases: events('release'),
  repository: events('custom_property_values', 'public', 'repository', 'repository_import'),
  rules: events('branch_protection_configuration', 'branch_protection_rule', 'repository_ruleset'),
  security: events(
    ...GITHUB_ALERT_EVENTS,
    'repository_advisory',
    'secret_scanning_alert_location',
    'security_and_analysis',
  ),
  stars: events('star'),
  watchers: events('watch'),
  webhooks: events('meta', 'ping'),
  wiki: events('gollum'),
  workflows: events('workflow_job', 'workflow_run'),
})

export type GitHubEventProfileName = keyof typeof GITHUB_EVENT_PROFILES

export const GITHUB_EVENT_PROFILE_DELIVERY_TYPES: Readonly<
  Partial<Record<GitHubEventProfileName, Readonly<Record<string, readonly string[]>>>>
> = Object.freeze({
  activity: Object.freeze({
    push: GITHUB_ACTIVITY_PUSH_DELIVERY_TYPES,
    pull_request: events('pull_request.opened', 'pull_request.closed'),
  }),
})

export const GITHUB_RECOMMENDED_EVENTS = events(
  'branch_protection_configuration',
  'branch_protection_rule',
  'code_scanning_alert',
  'dependabot_alert',
  'deploy_key',
  'issue_comment',
  'issues',
  'member',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'release',
  'repository',
  'repository_advisory',
  'repository_ruleset',
  'secret_scanning_alert',
  'security_and_analysis',
  'team_add',
  'workflow_run',
)

export const GITHUB_EVENT_PRESETS = Object.freeze(['recommended', 'all', 'manual'] as const)
export type GitHubEventPreset = (typeof GITHUB_EVENT_PRESETS)[number]
export type GitHubEventSelectionName = GitHubEventProfileName | GitHubEventPreset

export const GITHUB_EVENT_SELECTION_NAMES = Object.freeze([
  'recommended',
  ...Object.keys(GITHUB_EVENT_PROFILES).sort(),
  'all',
  'manual',
] as GitHubEventSelectionName[])

export interface GitHubEventSelection {
  kind: 'events' | 'all' | 'manual'
  names: readonly GitHubEventSelectionName[]
  events: readonly string[] | null
}

function isGitHubEventProfileName(value: string): value is GitHubEventProfileName {
  return Object.prototype.hasOwnProperty.call(GITHUB_EVENT_PROFILES, value)
}

function isGitHubEventPreset(value: string): value is GitHubEventPreset {
  return GITHUB_EVENT_PRESETS.some((preset) => preset === value)
}

function eventsForSelectionName(name: GitHubEventSelectionName): readonly string[] {
  return name === 'recommended'
    ? GITHUB_RECOMMENDED_EVENTS
    : GITHUB_EVENT_PROFILES[name as GitHubEventProfileName]
}

export function githubEventTypeFilter(selection: GitHubEventSelection): SubscriptionFilter | undefined {
  if (selection.kind !== 'events' || selection.events === null) return undefined

  const deliveryTypes = new Map<string, Set<string> | null>()
  for (const name of selection.names) {
    const profileDeliveryTypes = name === 'recommended'
      ? undefined
      : GITHUB_EVENT_PROFILE_DELIVERY_TYPES[name as GitHubEventProfileName]
    for (const event of eventsForSelectionName(name)) {
      const restrictedTypes = profileDeliveryTypes?.[event]
      if (restrictedTypes === undefined) {
        deliveryTypes.set(event, null)
        continue
      }
      const existing = deliveryTypes.get(event)
      if (existing === null) continue
      const combined = existing ?? new Set<string>()
      for (const type of restrictedTypes) combined.add(type)
      deliveryTypes.set(event, combined)
    }
  }

  if (![...deliveryTypes.values()].some((types) => types instanceof Set)) return undefined
  const include: string[] = []
  for (const event of selection.events) {
    const restrictedTypes = deliveryTypes.get(event)
    if (restrictedTypes instanceof Set) include.push(...restrictedTypes)
    else include.push(`${event}.*`)
  }
  return { eventTypes: { include } }
}

export function parseGitHubEventSelection(value: string): GitHubEventSelection {
  const rawNames = value.split(',').map((name) => name.trim())
  if (rawNames.some((name) => name.length === 0)) {
    throw new Error('GitHub event selection contains an empty profile name')
  }

  const duplicate = rawNames.find((name, index) => rawNames.indexOf(name) !== index)
  if (duplicate) throw new Error(`GitHub event profile selected more than once: ${duplicate}`)

  for (const name of rawNames) {
    if (!isGitHubEventProfileName(name) && !isGitHubEventPreset(name)) {
      throw new Error(
        `unknown GitHub event profile: ${name}; valid values: ${GITHUB_EVENT_SELECTION_NAMES.join(', ')}`,
      )
    }
  }

  const names = rawNames as GitHubEventSelectionName[]
  const exclusive = names.find((name) => name === 'all' || name === 'manual')
  if (exclusive && names.length > 1) {
    throw new Error(`GitHub event preset ${exclusive} cannot be combined with other profiles`)
  }
  if (exclusive === 'all') {
    return Object.freeze({ kind: 'all', names: Object.freeze(names), events: events('*') })
  }
  if (exclusive === 'manual') {
    return Object.freeze({ kind: 'manual', names: Object.freeze(names), events: null })
  }

  const expanded: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const profileEvents = eventsForSelectionName(name)
    for (const event of profileEvents) {
      if (seen.has(event)) continue
      seen.add(event)
      expanded.push(event)
    }
  }

  return Object.freeze({
    kind: 'events',
    names: Object.freeze(names),
    events: Object.freeze(expanded),
  })
}
