const events = <T extends readonly string[]>(...values: T): Readonly<T> => Object.freeze(values)

export const GITHUB_EVENT_PROFILES = Object.freeze({
  access: events('deploy_key', 'member', 'team_add'),
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
    'code_scanning_alert',
    'dependabot_alert',
    'repository_advisory',
    'repository_vulnerability_alert',
    'secret_scanning_alert',
    'secret_scanning_alert_location',
    'secret_scanning_scan',
    'security_and_analysis',
  ),
  stars: events('star'),
  watchers: events('watch'),
  webhooks: events('meta', 'ping'),
  wiki: events('gollum'),
  workflows: events('workflow_job', 'workflow_run'),
})

export type GitHubEventProfileName = keyof typeof GITHUB_EVENT_PROFILES

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
    const profileEvents = name === 'recommended'
      ? GITHUB_RECOMMENDED_EVENTS
      : GITHUB_EVENT_PROFILES[name as GitHubEventProfileName]
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
