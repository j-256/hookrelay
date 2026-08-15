import { describe, expect, it } from 'vitest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  assertGitHubFleetRepositoryCollisions,
  buildGitHubFleetSubscription,
  githubFleetHmacName,
  githubFleetSubscriptionName,
} from '../../scripts/github-fleet-model'

const SLUGS = {
  activity: 'abcdefghijklmnopqrstuv',
  stars: 'zyxwvutsrqponmlkjihgfe',
  alerts: '0123456789abcdefghijkl',
}

describe('GitHub fleet model', () => {
  it('uses the fixed names, event profiles, and sinks', async () => {
    expect(githubFleetSubscriptionName('example-owner/example-repo', 'activity')).toBe('github:example-owner/example-repo')
    expect(githubFleetSubscriptionName('example-owner/example-repo', 'stars')).toBe('github:example-owner/example-repo:stars')
    expect(githubFleetSubscriptionName('example-owner/example-repo', 'alerts')).toBe('github:example-owner/example-repo:alerts')
    expect(githubFleetHmacName('example-owner/example-repo')).toBe('HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO')

    const values = { hmacName: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO', slugs: SLUGS }
    const subscriptions = await Promise.all(
      GITHUB_FLEET_PROFILE_NAMES.map((profile) => buildGitHubFleetSubscription('example-owner/example-repo', profile, values)),
    )
    expect(subscriptions.map((sub) => sub.setup.github.eventProfiles)).toEqual([
      ['activity'],
      ['stars', 'watchers'],
      ['alerts'],
    ])
    expect(subscriptions.map((sub) => sub.sinks[0])).toEqual([
      'discord:repo-activity',
      'discord:github-stars',
      'discord:repo-alerts',
    ])
    expect(subscriptions.every((sub) => !Object.prototype.hasOwnProperty.call(sub, 'filter'))).toBe(true)
  })

  it('shares one HMAC while keeping three distinct slug hashes', async () => {
    const values = { hmacName: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO', slugs: SLUGS }
    const subscriptions = await Promise.all(
      GITHUB_FLEET_PROFILE_NAMES.map((profile) => buildGitHubFleetSubscription('example-owner/example-repo', profile, values)),
    )
    expect(new Set(subscriptions.map((sub) => sub.auth.secretEnv))).toEqual(new Set(['HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO']))
    expect(new Set(subscriptions.map((sub) => sub.slugHash))).toHaveProperty('size', 3)
  })

  it('blocks exact and normalized repository collisions', () => {
    expect(() => assertGitHubFleetRepositoryCollisions(['example-owner/example-repo', 'example-owner/example-repo'])).toThrow(/more than once/)
    expect(() => assertGitHubFleetRepositoryCollisions(['owner/a-b', 'owner/a_b'])).toThrow(/same HMAC name/)
  })
})
