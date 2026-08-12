import { describe, expect, it } from 'vitest'
import {
  GITHUB_EVENT_PROFILES,
  GITHUB_RECOMMENDED_EVENTS,
  parseGitHubEventSelection,
} from '../../scripts/github-events'

const REPOSITORY_EVENTS = [
  'branch_protection_configuration',
  'branch_protection_rule',
  'check_run',
  'check_suite',
  'code_scanning_alert',
  'commit_comment',
  'create',
  'custom_property_values',
  'delete',
  'dependabot_alert',
  'deploy_key',
  'deployment',
  'deployment_status',
  'discussion',
  'discussion_comment',
  'fork',
  'gollum',
  'issue_comment',
  'issue_dependencies',
  'issues',
  'label',
  'member',
  'meta',
  'milestone',
  'package',
  'page_build',
  'ping',
  'project',
  'project_card',
  'project_column',
  'public',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'pull_request_review_thread',
  'push',
  'registry_package',
  'release',
  'repository',
  'repository_advisory',
  'repository_import',
  'repository_ruleset',
  'repository_vulnerability_alert',
  'secret_scanning_alert',
  'secret_scanning_alert_location',
  'secret_scanning_scan',
  'security_and_analysis',
  'star',
  'status',
  'sub_issues',
  'team_add',
  'watch',
  'workflow_job',
  'workflow_run',
]

describe('GitHub event profiles', () => {
  it('partitions the repository webhook event catalog', () => {
    const profiled = Object.values(GITHUB_EVENT_PROFILES).flat().sort()
    expect(profiled).toEqual(REPOSITORY_EVENTS)
    expect(new Set(profiled).size).toBe(profiled.length)
  })

  it('composes profiles in order and expands stars and watchers separately', () => {
    expect(parseGitHubEventSelection('stars,watchers')).toEqual({
      kind: 'events',
      names: ['stars', 'watchers'],
      events: ['star', 'watch'],
    })
  })

  it('composes recommended with profiles and deduplicates raw events', () => {
    const selection = parseGitHubEventSelection('recommended,security,stars')
    expect(selection.names).toEqual(['recommended', 'security', 'stars'])
    expect(selection.events).toEqual([
      ...GITHUB_RECOMMENDED_EVENTS,
      'repository_vulnerability_alert',
      'secret_scanning_alert_location',
      'secret_scanning_scan',
      'star',
    ])
    expect(new Set(selection.events!).size).toBe(selection.events!.length)
  })

  it('preserves push, all, recommended, and manual behavior', () => {
    expect(parseGitHubEventSelection('push')).toMatchObject({ kind: 'events', events: ['push'] })
    expect(parseGitHubEventSelection('all')).toEqual({ kind: 'all', names: ['all'], events: ['*'] })
    expect(parseGitHubEventSelection('manual')).toEqual({ kind: 'manual', names: ['manual'], events: null })
    expect(parseGitHubEventSelection('recommended').events).toEqual(GITHUB_RECOMMENDED_EVENTS)
  })

  it('rejects unknown, empty, duplicate, and invalid exclusive selections', () => {
    expect(() => parseGitHubEventSelection('nope')).toThrow(/unknown GitHub event profile/)
    expect(() => parseGitHubEventSelection('stars,,watchers')).toThrow(/empty profile/)
    expect(() => parseGitHubEventSelection('stars,stars')).toThrow(/more than once/)
    expect(() => parseGitHubEventSelection('all,stars')).toThrow(/cannot be combined/)
    expect(() => parseGitHubEventSelection('manual,push')).toThrow(/cannot be combined/)
  })
})
