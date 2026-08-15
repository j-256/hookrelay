import { describe, expect, it } from 'vitest'
import {
  GITHUB_ACTIVITY_EVENTS,
  GITHUB_ALERT_EVENTS,
  GITHUB_EVENT_PROFILES,
  GITHUB_RECOMMENDED_EVENTS,
  githubEventTypeFilter,
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
  'secret_scanning_alert',
  'secret_scanning_alert_location',
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
  it('covers the supported repository webhook event catalog', () => {
    const profiled = [...new Set(Object.values(GITHUB_EVENT_PROFILES).flat())].sort()
    expect(profiled).toEqual(REPOSITORY_EVENTS)
    for (const profile of Object.values(GITHUB_EVENT_PROFILES)) {
      expect(new Set(profile).size).toBe(profile.length)
    }
  })

  it('expands purpose-specific activity and alert profiles', () => {
    expect(GITHUB_ACTIVITY_EVENTS).toEqual(['push', 'workflow_run', 'pull_request'])
    expect(parseGitHubEventSelection('activity,alerts')).toEqual({
      kind: 'events',
      names: ['activity', 'alerts'],
      events: [...GITHUB_ACTIVITY_EVENTS, ...GITHUB_ALERT_EVENTS],
    })
    expect(GITHUB_EVENT_PROFILES.security).toEqual([
      ...GITHUB_ALERT_EVENTS,
      'repository_advisory',
      'secret_scanning_alert_location',
      'security_and_analysis',
    ])
  })

  it('derives one shared activity delivery rule from event profiles', () => {
    expect(githubEventTypeFilter(parseGitHubEventSelection('activity'))).toEqual({
      eventTypes: {
        include: [
          'push.*',
          'workflow_run.*',
          'pull_request.opened',
          'pull_request.closed',
        ],
      },
    })
    expect(githubEventTypeFilter(parseGitHubEventSelection('activity,alerts'))).toEqual({
      eventTypes: {
        include: [
          'push.*',
          'workflow_run.*',
          'pull_request.opened',
          'pull_request.closed',
          'code_scanning_alert.*',
          'dependabot_alert.*',
          'secret_scanning_alert.*',
        ],
      },
    })
  })

  it('lets an unrestricted profile broaden an overlapping event', () => {
    expect(githubEventTypeFilter(parseGitHubEventSelection('activity,pull-requests'))).toBeUndefined()
    expect(githubEventTypeFilter(parseGitHubEventSelection('recommended,activity'))).toBeUndefined()
    expect(githubEventTypeFilter(parseGitHubEventSelection('pull-requests'))).toBeUndefined()
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
      'secret_scanning_alert_location',
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
