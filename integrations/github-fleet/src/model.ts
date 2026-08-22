import { hashSubscriptionSlug } from '../../../src/lib/subscription'
import { envSegment } from '../../../scripts/setup'

export const GITHUB_FLEET_AUTH_SCHEME = 'github-sha256'

export const GITHUB_FLEET_PROFILES = Object.freeze({
  activity: Object.freeze({
    suffix: '',
    eventProfiles: Object.freeze(['activity']),
    sink: 'discord:repo-activity',
  }),
  stars: Object.freeze({
    suffix: ':stars',
    eventProfiles: Object.freeze(['stars', 'watchers']),
    sink: 'discord:github-stars',
  }),
  alerts: Object.freeze({
    suffix: ':alerts',
    eventProfiles: Object.freeze(['alerts']),
    sink: 'discord:repo-alerts',
  }),
})

export const GITHUB_FLEET_PROFILE_NAMES = Object.freeze(
  Object.keys(GITHUB_FLEET_PROFILES) as GitHubFleetProfileName[],
)

export type GitHubFleetProfileName = keyof typeof GITHUB_FLEET_PROFILES
export type GitHubFleetProgress = (message: string) => void

export function parseGitHubFleetProfiles(value: string): GitHubFleetProfileName[] {
  const requested = value.split(',')
  if (requested.some((profile) => profile === '')) {
    throw new Error('GitHub fleet profiles contain an empty name')
  }
  const selected = new Set<GitHubFleetProfileName>()
  for (const profile of requested) {
    if (!GITHUB_FLEET_PROFILE_NAMES.includes(profile as GitHubFleetProfileName)) {
      throw new Error(`unknown GitHub fleet profile: ${profile}; valid values: ${GITHUB_FLEET_PROFILE_NAMES.join(', ')}`)
    }
    const name = profile as GitHubFleetProfileName
    if (selected.has(name)) throw new Error(`GitHub fleet profile selected more than once: ${name}`)
    selected.add(name)
  }
  return GITHUB_FLEET_PROFILE_NAMES.filter((profile) => selected.has(profile))
}

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
