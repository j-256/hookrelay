import { describe, expect, it } from 'vitest'
import { parseGitHubEventSelection } from '../../../../scripts/providers/github/event-profiles'
import {
  githubSubscriptionEventsUsage,
  parseGitHubSubscriptionEventsArgs,
  prepareGitHubSubscriptionEvents,
} from '../../../../scripts/providers/github/subscription-events'
import { parseRoutes } from '../../../../scripts/sync'

const FIRST_HASH = 'a'.repeat(64)
const SECOND_HASH = 'b'.repeat(64)
const STATUS_HASH = 'c'.repeat(64)
const ROUTES = `
// Preserve this routes comment
{
  "subs": [
    {
      "name": "github:example-owner/example-repo",
      "source": "github",
      "slugHash": "${FIRST_HASH}",
      "enabled": true,
      "sinks": [],
      "auth": { "scheme": "github-sha256", "secretEnv": "HMAC_SITE" },
      "setup": {
        "github": {
          "repo": "example-owner/example-repo",
          "eventProfiles": ["activity", "alerts"]
        }
      }
    },
    {
      "name": "github:example-owner/example-repo:stars",
      "source": "github",
      "slugHash": "${SECOND_HASH}",
      "enabled": true,
      "sinks": [],
      "setup": {
        "github": {
          "repo": "example-owner/example-repo",
          "eventProfiles": ["stars", "watchers"]
        }
      }
    },
    {
      "name": "status",
      "source": "statuspage",
      "slugHash": "${STATUS_HASH}",
      "enabled": true,
      "sinks": []
    }
  ],
  "sinks": []
}
`

describe('parseGitHubSubscriptionEventsArgs', () => {
  it('accepts a replacement selection or saved-route reconciliation', () => {
    expect(parseGitHubSubscriptionEventsArgs(['github:example-owner/example-repo'])).toEqual({
      name: 'github:example-owner/example-repo',
      githubEvents: undefined,
      yes: false,
    })
    expect(parseGitHubSubscriptionEventsArgs([
      'github:example-owner/example-repo',
      '-e',
      'recommended,stars',
      '-y',
    ])).toMatchObject({
      name: 'github:example-owner/example-repo',
      yes: true,
      githubEvents: { kind: 'events', names: ['recommended', 'stars'] },
    })
  })

  it('rejects missing, duplicate, and unknown options', () => {
    expect(() => parseGitHubSubscriptionEventsArgs([])).toThrow(/usage: pnpm github:events/)
    expect(() => parseGitHubSubscriptionEventsArgs(['site', '-e', 'push', '--events', 'stars'])).toThrow(/only be supplied once/)
    expect(() => parseGitHubSubscriptionEventsArgs(['site', '-e'])).toThrow(/requires a value/)
    expect(() => parseGitHubSubscriptionEventsArgs(['site', '-x'])).toThrow(/unknown option/)
    expect(githubSubscriptionEventsUsage()).toContain('routes.jsonc')
  })
})

describe('prepareGitHubSubscriptionEvents', () => {
  it('replaces only the selected profile metadata and preserves JSONC comments', () => {
    const prepared = prepareGitHubSubscriptionEvents(
      ROUTES,
      'github:example-owner/example-repo',
      parseGitHubEventSelection('recommended,stars'),
    )
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesChanged).toBe(true)
    expect(prepared.previousProfileNames).toEqual(['activity', 'alerts'])
    expect(prepared.secretEnv).toBe('HMAC_SITE')
    expect(prepared.routesText).toContain('// Preserve this routes comment')
    expect(routes.subs[0]!.setup!.github!.eventProfiles).toEqual(['recommended', 'stars'])
    expect(routes.subs[1]!.setup!.github!.eventProfiles).toEqual(['stars', 'watchers'])
    expect(routes.subs[0]!.slugHash).toBe(FIRST_HASH)
    expect(routes.subs[0]!.auth).toEqual({ scheme: 'github-sha256', secretEnv: 'HMAC_SITE' })
  })

  it('uses saved profiles without rewriting the file', () => {
    const prepared = prepareGitHubSubscriptionEvents(ROUTES, 'github:example-owner/example-repo')

    expect(prepared.routesChanged).toBe(false)
    expect(prepared.routesText).toBe(ROUTES)
    expect(prepared.githubEvents).toEqual(parseGitHubEventSelection('activity,alerts'))
  })

  it('supports wildcard and local-only manual selections', () => {
    expect(prepareGitHubSubscriptionEvents(
      ROUTES,
      'github:example-owner/example-repo',
      parseGitHubEventSelection('all'),
    ).githubEvents).toMatchObject({ kind: 'all', events: ['*'] })
    expect(prepareGitHubSubscriptionEvents(
      ROUTES,
      'github:example-owner/example-repo',
      parseGitHubEventSelection('manual'),
    ).githubEvents).toMatchObject({ kind: 'manual', events: null })
  })

  it('requires one configured GitHub subscription', () => {
    expect(() => prepareGitHubSubscriptionEvents(ROUTES, 'missing')).toThrow(/does not exist/)
    expect(() => prepareGitHubSubscriptionEvents(ROUTES, 'status')).toThrow(/not a GitHub subscription/)
    expect(() => prepareGitHubSubscriptionEvents(
      ROUTES.replace('"setup": {', '"setupOther": {'),
      'github:example-owner/example-repo',
    )).toThrow()
    expect(() => prepareGitHubSubscriptionEvents(
      ROUTES.replace('"repo": "example-owner/example-repo"', '"repo": "not-a-repository"'),
      'github:example-owner/example-repo',
    )).toThrow(/invalid GitHub repository/)
    expect(() => prepareGitHubSubscriptionEvents(
      ROUTES.replace('"auth": { "scheme": "github-sha256", "secretEnv": "HMAC_SITE" },', ''),
      'github:example-owner/example-repo',
    )).toThrow(/sender secret/)
  })
})
