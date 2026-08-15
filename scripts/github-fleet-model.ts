import { hashSubscriptionSlug } from '../src/lib/subscription'
import type { SubscriptionFilter } from '../src/types'
import { envSegment } from './setup'

export const GITHUB_FLEET_AUTH_SCHEME = 'github-sha256'
export const GITHUB_ACTIVITY_DELIVERY_TYPES = Object.freeze([
  'push.*',
  'workflow_run.*',
  'pull_request.opened',
  'pull_request.closed',
])

interface ReadonlySubscriptionFilter {
  readonly eventTypes: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
  }
}

const GITHUB_ACTIVITY_FILTER: ReadonlySubscriptionFilter = Object.freeze({
  eventTypes: Object.freeze({
    include: GITHUB_ACTIVITY_DELIVERY_TYPES,
  }),
})

export const GITHUB_FLEET_PROFILES = Object.freeze({
  activity: Object.freeze({
    suffix: '',
    eventProfiles: Object.freeze(['activity']),
    sink: 'discord:repo-activity',
    filter: GITHUB_ACTIVITY_FILTER,
  }),
  stars: Object.freeze({
    suffix: ':stars',
    eventProfiles: Object.freeze(['stars', 'watchers']),
    sink: 'discord:github-stars',
    filter: undefined,
  }),
  alerts: Object.freeze({
    suffix: ':alerts',
    eventProfiles: Object.freeze(['alerts']),
    sink: 'discord:repo-alerts',
    filter: undefined,
  }),
})

export const GITHUB_FLEET_PROFILE_NAMES = Object.freeze(
  Object.keys(GITHUB_FLEET_PROFILES) as GitHubFleetProfileName[],
)

export type GitHubFleetProfileName = keyof typeof GITHUB_FLEET_PROFILES

export interface GitHubFleetValues {
  hmacName: string
  slugs: Record<GitHubFleetProfileName, string>
}

export interface GitHubFleetSubscription {
  name: string
  source: 'github'
  slugHash: string
  enabled: true
  sinks: string[]
  auth: {
    scheme: typeof GITHUB_FLEET_AUTH_SCHEME
    secretEnv: string
  }
  filter?: SubscriptionFilter
  setup: {
    github: {
      repo: string
      eventProfiles: string[]
    }
  }
}

export function githubFleetSubscriptionName(repo: string, profile: GitHubFleetProfileName): string {
  return `github:${repo}${GITHUB_FLEET_PROFILES[profile].suffix}`
}

export function githubFleetHmacName(repo: string): string {
  return `HMAC_GITHUB_${envSegment(repo)}`
}

export async function buildGitHubFleetSubscription(
  repo: string,
  profile: GitHubFleetProfileName,
  values: GitHubFleetValues,
): Promise<GitHubFleetSubscription> {
  const definition = GITHUB_FLEET_PROFILES[profile]
  return {
    name: githubFleetSubscriptionName(repo, profile),
    source: 'github',
    slugHash: await hashSubscriptionSlug(values.slugs[profile]),
    enabled: true,
    sinks: [definition.sink],
    auth: {
      scheme: GITHUB_FLEET_AUTH_SCHEME,
      secretEnv: values.hmacName,
    },
    ...(definition.filter
      ? {
          filter: {
            eventTypes: {
              ...(definition.filter.eventTypes.include
                ? { include: [...definition.filter.eventTypes.include] }
                : {}),
              ...(definition.filter.eventTypes.exclude
                ? { exclude: [...definition.filter.eventTypes.exclude] }
                : {}),
            },
          },
        }
      : {}),
    setup: {
      github: {
        repo,
        eventProfiles: [...definition.eventProfiles],
      },
    },
  }
}

export function assertGitHubFleetRepositoryCollisions(repositories: readonly string[]): void {
  const exact = new Set<string>()
  const hmacOwners = new Map<string, string>()
  for (const repo of repositories) {
    if (exact.has(repo)) throw new Error(`GitHub repository appears more than once: ${repo}`)
    exact.add(repo)
    const hmacName = githubFleetHmacName(repo)
    const owner = hmacOwners.get(hmacName)
    if (owner && owner !== repo) {
      throw new Error(`GitHub repositories ${owner} and ${repo} normalize to the same HMAC name ${hmacName}`)
    }
    hmacOwners.set(hmacName, repo)
  }
}
