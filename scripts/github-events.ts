export const GITHUB_EVENT_MODES = Object.freeze(['push', 'all', 'recommended', 'manual'] as const)

export type GitHubEventMode = (typeof GITHUB_EVENT_MODES)[number]

export const GITHUB_RECOMMENDED_EVENTS = Object.freeze([
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
] as const)

const GITHUB_ALL_EVENTS = Object.freeze(['*'])
const GITHUB_PUSH_EVENTS = Object.freeze(['push'])

export function isGitHubEventMode(value: string): value is GitHubEventMode {
  return GITHUB_EVENT_MODES.some((mode) => mode === value)
}

export function githubEventsForMode(mode: GitHubEventMode): readonly string[] | null {
  switch (mode) {
    case 'push':
      return GITHUB_PUSH_EVENTS
    case 'all':
      return GITHUB_ALL_EVENTS
    case 'recommended':
      return GITHUB_RECOMMENDED_EVENTS
    case 'manual':
      return null
  }
}
