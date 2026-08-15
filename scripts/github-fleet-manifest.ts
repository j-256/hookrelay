import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { SUBSCRIPTION_SLUG_RE } from '../src/lib/subscription'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  assertGitHubFleetRepositoryCollisions,
  githubFleetHmacName,
  type GitHubFleetProfileName,
  type GitHubFleetValues,
} from './github-fleet-model'

const MANIFEST_VERSION = 2
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/

const secretSchema = z.object({
  name: z.string().regex(SECRET_NAME_RE),
  value: z.string().min(1),
}).strict()

const slugsSchema = z.object({
  activity: z.string().regex(SUBSCRIPTION_SLUG_RE),
  stars: z.string().regex(SUBSCRIPTION_SLUG_RE),
  alerts: z.string().regex(SUBSCRIPTION_SLUG_RE),
}).strict()

const baseRepositorySchema = z.object({
  hmac: secretSchema,
  slugs: slugsSchema,
}).strict()

const hookRetirementSchema = z.object({
  id: z.number().int().positive(),
  deleted: z.boolean(),
}).strict()

const retirementSchema = z.object({
  preparedAt: z.string().datetime(),
  hooks: z.object({
    activity: hookRetirementSchema.optional(),
    stars: hookRetirementSchema.optional(),
    alerts: hookRetirementSchema.optional(),
  }).strict(),
  routesRemoved: z.boolean(),
  kvRemoved: z.boolean(),
  secretRemoved: z.boolean(),
}).strict()

const repositorySchema = baseRepositorySchema.extend({
  state: z.enum(['active', 'retiring']),
  retirement: retirementSchema.optional(),
}).strict()

const retiredRepositorySchema = baseRepositorySchema.extend({
  retiredAt: z.string().datetime(),
}).strict()

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  repositories: z.record(z.string().regex(REPOSITORY_RE), repositorySchema),
  retiredRepositories: z.record(z.string().regex(REPOSITORY_RE), retiredRepositorySchema),
}).strict()

export type GitHubFleetSecret = z.infer<typeof secretSchema>
export type GitHubFleetRetirement = z.infer<typeof retirementSchema>
export type GitHubFleetRetirementHook = z.infer<typeof hookRetirementSchema>
export type GitHubFleetManifestRepository = z.infer<typeof repositorySchema>
export type GitHubFleetRetiredRepository = z.infer<typeof retiredRepositorySchema>
export type GitHubFleetManifest = z.infer<typeof manifestSchema>

export interface GitHubFleetRandomValues {
  hmac(): string
  slug(): string
}

const DEFAULT_RANDOM_VALUES: GitHubFleetRandomValues = Object.freeze({
  hmac: () => randomBytes(32).toString('hex'),
  slug: () => randomBytes(16).toString('base64url'),
})

export function emptyGitHubFleetManifest(): GitHubFleetManifest {
  return { version: MANIFEST_VERSION, repositories: {}, retiredRepositories: {} }
}

export function parseGitHubFleetManifest(text: string): GitHubFleetManifest {
  if (text.trim() === '') return emptyGitHubFleetManifest()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('failed to parse GitHub fleet manifest as JSON')
  }
  const result = manifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    throw new Error(`invalid GitHub fleet manifest\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
  }
  validateGitHubFleetManifest(result.data)
  return result.data
}

export function validateGitHubFleetManifest(manifest: GitHubFleetManifest): void {
  const retiredRepositories = manifest.retiredRepositories
  const repositories = [...Object.keys(manifest.repositories), ...Object.keys(retiredRepositories)]
  assertGitHubFleetRepositoryCollisions(repositories)
  const slugOwners = new Map<string, string>()
  const hmacValueOwners = new Map<string, string>()

  for (const repo of Object.keys(manifest.repositories)) {
    const entry = manifest.repositories[repo]!
    if (entry.state === 'retiring' && !entry.retirement) {
      throw new Error(`manifest repository ${repo} is retiring without phase state`)
    }
    if (entry.state === 'active' && entry.retirement) {
      throw new Error(`manifest repository ${repo} is active with retirement phase state`)
    }
  }

  for (const repo of repositories) {
    const entry = manifest.repositories[repo] ?? retiredRepositories[repo]!
    const expectedName = githubFleetHmacName(repo)
    if (entry.hmac.name !== expectedName) {
      throw new Error(`manifest repository ${repo} must use HMAC name ${expectedName}`)
    }
    const localSlugs = new Set(Object.values(entry.slugs))
    if (localSlugs.size !== GITHUB_FLEET_PROFILE_NAMES.length) {
      throw new Error(`manifest repository ${repo} must use distinct subscription slugs`)
    }
    for (const slug of localSlugs) {
      const owner = slugOwners.get(slug)
      if (owner) throw new Error(`manifest repositories ${owner} and ${repo} share a subscription slug`)
      slugOwners.set(slug, repo)
    }
    const hmacOwner = hmacValueOwners.get(entry.hmac.value)
    if (hmacOwner) throw new Error(`manifest repositories ${hmacOwner} and ${repo} share an HMAC value`)
    hmacValueOwners.set(entry.hmac.value, repo)
  }
}

export function serializeGitHubFleetManifest(manifest: GitHubFleetManifest): string {
  validateGitHubFleetManifest(manifest)
  const repositories: GitHubFleetManifest['repositories'] = {}
  const retiredRepositories: Record<string, GitHubFleetRetiredRepository> = {}
  for (const repo of Object.keys(manifest.repositories).sort()) {
    const entry = manifest.repositories[repo]!
    repositories[repo] = {
      hmac: entry.hmac,
      slugs: {
        activity: entry.slugs.activity,
        stars: entry.slugs.stars,
        alerts: entry.slugs.alerts,
      },
      state: entry.state,
      ...(entry.retirement
        ? {
            retirement: {
              preparedAt: entry.retirement.preparedAt,
              hooks: Object.fromEntries(GITHUB_FLEET_PROFILE_NAMES
                .filter((profile) => entry.retirement?.hooks[profile] !== undefined)
                .map((profile) => [profile, { ...entry.retirement!.hooks[profile]! }])),
              routesRemoved: entry.retirement.routesRemoved,
              kvRemoved: entry.retirement.kvRemoved,
              secretRemoved: entry.retirement.secretRemoved,
            },
          }
        : {}),
    }
  }
  for (const repo of Object.keys(manifest.retiredRepositories).sort()) {
    const entry = manifest.retiredRepositories[repo]!
    retiredRepositories[repo] = {
      hmac: entry.hmac,
      slugs: {
        activity: entry.slugs.activity,
        stars: entry.slugs.stars,
        alerts: entry.slugs.alerts,
      },
      retiredAt: entry.retiredAt,
    }
  }
  return `${JSON.stringify({ version: MANIFEST_VERSION, repositories, retiredRepositories }, null, 2)}\n`
}

export function generateGitHubFleetManifestRepository(
  repo: string,
  randomValues: GitHubFleetRandomValues = DEFAULT_RANDOM_VALUES,
): GitHubFleetManifestRepository {
  return {
    hmac: {
      name: githubFleetHmacName(repo),
      value: randomValues.hmac(),
    },
    slugs: {
      activity: randomValues.slug(),
      stars: randomValues.slug(),
      alerts: randomValues.slug(),
    },
    state: 'active',
  }
}

function sameRepositoryEntry(
  left: GitHubFleetManifestRepository,
  right: GitHubFleetManifestRepository,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function withGitHubFleetManifestRepository(
  manifest: GitHubFleetManifest,
  repo: string,
  entry: GitHubFleetManifestRepository,
): GitHubFleetManifest {
  const existing = manifest.repositories[repo]
  if (existing && !sameRepositoryEntry(existing, entry)) {
    throw new Error(`manifest repository ${repo} disagrees with recovered or generated values`)
  }
  const next: GitHubFleetManifest = {
    version: MANIFEST_VERSION,
    repositories: { ...manifest.repositories, [repo]: existing ?? entry },
    retiredRepositories: { ...manifest.retiredRepositories },
  }
  validateGitHubFleetManifest(next)
  return next
}

export function beginGitHubFleetRepositoryRetirement(
  manifest: GitHubFleetManifest,
  repo: string,
  preparedAt: string,
): GitHubFleetManifest {
  if (manifest.retiredRepositories[repo]) return manifest
  const entry = manifest.repositories[repo]
  if (!entry) throw new Error(`manifest repository is missing: ${repo}`)
  if (entry.state === 'retiring') return manifest
  const next: GitHubFleetManifest = {
    ...manifest,
    repositories: {
      ...manifest.repositories,
      [repo]: {
        ...entry,
        state: 'retiring',
        retirement: {
          preparedAt,
          hooks: {},
          routesRemoved: false,
          kvRemoved: false,
          secretRemoved: false,
        },
      },
    },
  }
  validateGitHubFleetManifest(next)
  return next
}

export function updateGitHubFleetRepositoryRetirement(
  manifest: GitHubFleetManifest,
  repo: string,
  update: Partial<GitHubFleetRetirement>,
): GitHubFleetManifest {
  const entry = manifest.repositories[repo]
  if (!entry || entry.state !== 'retiring' || !entry.retirement) {
    throw new Error(`manifest repository is not retiring: ${repo}`)
  }
  const next: GitHubFleetManifest = {
    ...manifest,
    repositories: {
      ...manifest.repositories,
      [repo]: {
        ...entry,
        retirement: { ...entry.retirement, ...update },
      },
    },
  }
  validateGitHubFleetManifest(next)
  return next
}

export function completeGitHubFleetRepositoryRetirement(
  manifest: GitHubFleetManifest,
  repo: string,
  retiredAt: string,
): GitHubFleetManifest {
  if (manifest.retiredRepositories[repo]) return manifest
  const entry = manifest.repositories[repo]
  if (!entry || entry.state !== 'retiring' || !entry.retirement) {
    throw new Error(`manifest repository is not retiring: ${repo}`)
  }
  const { [repo]: _removed, ...repositories } = manifest.repositories
  const next: GitHubFleetManifest = {
    version: MANIFEST_VERSION,
    repositories,
    retiredRepositories: {
      ...manifest.retiredRepositories,
      [repo]: {
        hmac: entry.hmac,
        slugs: entry.slugs,
        retiredAt,
      },
    },
  }
  validateGitHubFleetManifest(next)
  return next
}

export function githubFleetManifestValues(
  entry: GitHubFleetManifestRepository | GitHubFleetRetiredRepository,
): GitHubFleetValues {
  return {
    hmacName: entry.hmac.name,
    slugs: { ...entry.slugs } as Record<GitHubFleetProfileName, string>,
  }
}
