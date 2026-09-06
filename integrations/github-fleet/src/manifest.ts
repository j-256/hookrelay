import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { SUBSCRIPTION_SLUG_RE } from '../../../src/lib/subscription'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  assertGitHubFleetRepositoryCollisions,
  githubFleetHmacName,
  type GitHubFleetProfileName,
  type GitHubFleetValues,
} from './model'

const LEGACY_MANIFEST_VERSION_TWO = 2
const LEGACY_MANIFEST_VERSION_THREE = 3
const MANIFEST_VERSION = 4
const PROFILE_MANIFEST_VERSION = 3
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/

const profileSchema = z.custom<GitHubFleetProfileName>((value) => (
  typeof value === 'string' && GITHUB_FLEET_PROFILE_NAMES.includes(value as GitHubFleetProfileName)
))

const secretSchema = z.object({
  name: z.string().regex(SECRET_NAME_RE),
  value: z.string().min(1),
}).strict()

const slugsSchema = z.object({
  activity: z.string().regex(SUBSCRIPTION_SLUG_RE),
  stars: z.string().regex(SUBSCRIPTION_SLUG_RE),
  alerts: z.string().regex(SUBSCRIPTION_SLUG_RE),
}).strict()

const partialSlugsSchema = z.object({
  activity: z.string().regex(SUBSCRIPTION_SLUG_RE).optional(),
  stars: z.string().regex(SUBSCRIPTION_SLUG_RE).optional(),
  alerts: z.string().regex(SUBSCRIPTION_SLUG_RE).optional(),
}).strict()

const slugRotationSchema = z.object({
  preparedAt: z.string().datetime(),
  profiles: z.array(profileSchema).min(1),
  previousSlugs: partialSlugsSchema,
}).strict()

const baseRepositorySchema = z.object({
  hmac: secretSchema,
  slugs: slugsSchema,
  profiles: z.array(profileSchema).min(1).optional(),
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
  slugRotation: slugRotationSchema.optional(),
}).strict()

const retiredRepositorySchema = baseRepositorySchema.extend({
  retiredAt: z.string().datetime(),
}).strict()

const manifestSchema = z.object({
  version: z.union([
    z.literal(LEGACY_MANIFEST_VERSION_TWO),
    z.literal(LEGACY_MANIFEST_VERSION_THREE),
    z.literal(MANIFEST_VERSION),
  ]),
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

  if (
    manifest.version === LEGACY_MANIFEST_VERSION_TWO
    && repositories.some((repo) => (manifest.repositories[repo] ?? retiredRepositories[repo])?.profiles !== undefined)
  ) {
    throw new Error(`manifest version ${PROFILE_MANIFEST_VERSION} is required for selected profiles`)
  }

  for (const repo of Object.keys(manifest.repositories)) {
    const entry = manifest.repositories[repo]!
    if (entry.state === 'retiring' && !entry.retirement) {
      throw new Error(`manifest repository ${repo} is retiring without phase state`)
    }
    if (entry.state === 'active' && entry.retirement) {
      throw new Error(`manifest repository ${repo} is active with retirement phase state`)
    }
    if (entry.state === 'retiring' && entry.slugRotation) {
      throw new Error(`manifest repository ${repo} cannot rotate slugs while retiring`)
    }
  }

  for (const repo of repositories) {
    const entry = manifest.repositories[repo] ?? retiredRepositories[repo]!
    const expectedName = githubFleetHmacName(repo)
    if (entry.hmac.name !== expectedName) {
      throw new Error(`manifest repository ${repo} must use HMAC name ${expectedName}`)
    }
    if (entry.profiles) {
      const canonicalProfiles = GITHUB_FLEET_PROFILE_NAMES.filter((profile) => entry.profiles!.includes(profile))
      if (
        canonicalProfiles.length !== entry.profiles.length
        || !canonicalProfiles.every((profile, index) => entry.profiles![index] === profile)
      ) {
        throw new Error(`manifest repository ${repo} profiles must be unique and use canonical order`)
      }
    }
    const localSlugs = new Set(Object.values(entry.slugs))
    if (localSlugs.size !== GITHUB_FLEET_PROFILE_NAMES.length) {
      throw new Error(`manifest repository ${repo} must use distinct subscription slugs`)
    }
    for (const [profile, slug] of Object.entries(entry.slugs)) {
      const owner = slugOwners.get(slug)
      if (owner) throw new Error(`manifest repositories ${owner} and ${repo} share a subscription slug`)
      slugOwners.set(slug, `${repo}:${profile}`)
    }
    const slugRotation = 'state' in entry ? entry.slugRotation : undefined
    if (slugRotation) {
      if (manifest.version !== MANIFEST_VERSION) {
        throw new Error(`manifest version ${MANIFEST_VERSION} is required for slug rotation`)
      }
      const canonicalProfiles = GITHUB_FLEET_PROFILE_NAMES.filter((profile) => (
        slugRotation.profiles.includes(profile)
      ))
      if (
        canonicalProfiles.length !== slugRotation.profiles.length
        || !canonicalProfiles.every((profile, index) => slugRotation.profiles[index] === profile)
      ) {
        throw new Error(`manifest repository ${repo} slug rotation profiles must be unique and use canonical order`)
      }
      const previousProfiles = GITHUB_FLEET_PROFILE_NAMES.filter((profile) => (
        slugRotation.previousSlugs[profile] !== undefined
      ))
      if (!canonicalProfiles.every((profile, index) => previousProfiles[index] === profile)
        || canonicalProfiles.length !== previousProfiles.length) {
        throw new Error(`manifest repository ${repo} slug rotation previous values must match its profiles`)
      }
      const activeProfiles = githubFleetManifestProfiles(entry)
      for (const profile of canonicalProfiles) {
        if (!activeProfiles.includes(profile)) {
          throw new Error(`manifest repository ${repo} cannot rotate inactive profile ${profile}`)
        }
        const previous = slugRotation.previousSlugs[profile]!
        if (previous === entry.slugs[profile]) {
          throw new Error(`manifest repository ${repo} slug rotation must replace profile ${profile}`)
        }
        const owner = slugOwners.get(previous)
        if (owner) throw new Error(`manifest repositories ${owner} and ${repo} share a subscription slug`)
        slugOwners.set(previous, `${repo}:${profile}:previous`)
      }
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
      ...(entry.profiles ? { profiles: [...entry.profiles] } : {}),
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
      ...(entry.slugRotation
        ? {
            slugRotation: {
              preparedAt: entry.slugRotation.preparedAt,
              profiles: [...entry.slugRotation.profiles],
              previousSlugs: Object.fromEntries(entry.slugRotation.profiles.map((profile) => [
                profile,
                entry.slugRotation!.previousSlugs[profile]!,
              ])),
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
      ...(entry.profiles ? { profiles: [...entry.profiles] } : {}),
      retiredAt: entry.retiredAt,
    }
  }
  return `${JSON.stringify({ version: manifest.version, repositories, retiredRepositories }, null, 2)}\n`
}

export function generateGitHubFleetManifestRepository(
  repo: string,
  randomValues: GitHubFleetRandomValues = DEFAULT_RANDOM_VALUES,
  profiles: readonly GitHubFleetProfileName[] = GITHUB_FLEET_PROFILE_NAMES,
): GitHubFleetManifestRepository {
  const savesDefaultProfiles = profiles.length === GITHUB_FLEET_PROFILE_NAMES.length
    && profiles.every((profile, index) => GITHUB_FLEET_PROFILE_NAMES[index] === profile)
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
    ...(!savesDefaultProfiles ? { profiles: [...profiles] } : {}),
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
    version: manifest.version,
    repositories,
    retiredRepositories: {
      ...manifest.retiredRepositories,
      [repo]: {
        hmac: entry.hmac,
        slugs: entry.slugs,
        ...(entry.profiles ? { profiles: [...entry.profiles] } : {}),
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

export function githubFleetManifestProfiles(
  entry: GitHubFleetManifestRepository | GitHubFleetRetiredRepository,
): readonly GitHubFleetProfileName[] {
  return entry.profiles ?? GITHUB_FLEET_PROFILE_NAMES
}

export function beginGitHubFleetSlugRotation(
  manifest: GitHubFleetManifest,
  repo: string,
  profiles: readonly GitHubFleetProfileName[],
  preparedAt: string,
  randomValues: GitHubFleetRandomValues = DEFAULT_RANDOM_VALUES,
): GitHubFleetManifest {
  const entry = manifest.repositories[repo]
  if (!entry || entry.state !== 'active') {
    throw new Error(`manifest repository is not active: ${repo}`)
  }
  const canonicalProfiles = GITHUB_FLEET_PROFILE_NAMES.filter((profile) => profiles.includes(profile))
  if (canonicalProfiles.length !== profiles.length
    || !canonicalProfiles.every((profile, index) => profiles[index] === profile)) {
    throw new Error(`slug rotation profiles for ${repo} must be unique and use canonical order`)
  }
  if (entry.slugRotation) {
    if (entry.slugRotation.profiles.length !== canonicalProfiles.length
      || !entry.slugRotation.profiles.every((profile, index) => canonicalProfiles[index] === profile)) {
      throw new Error(`${repo}: pending slug rotation uses a different profile selection`)
    }
    return manifest
  }
  const activeProfiles = githubFleetManifestProfiles(entry)
  for (const profile of canonicalProfiles) {
    if (!activeProfiles.includes(profile)) throw new Error(`${repo}: cannot rotate inactive profile ${profile}`)
  }
  const previousSlugs: Partial<Record<GitHubFleetProfileName, string>> = {}
  const slugs = { ...entry.slugs }
  for (const profile of canonicalProfiles) {
    previousSlugs[profile] = entry.slugs[profile]
    slugs[profile] = randomValues.slug()
  }
  const next: GitHubFleetManifest = {
    ...manifest,
    version: MANIFEST_VERSION,
    repositories: {
      ...manifest.repositories,
      [repo]: {
        ...entry,
        slugs,
        slugRotation: {
          preparedAt,
          profiles: [...canonicalProfiles],
          previousSlugs,
        },
      },
    },
  }
  validateGitHubFleetManifest(next)
  return next
}

export function completeGitHubFleetSlugRotation(
  manifest: GitHubFleetManifest,
  repo: string,
): GitHubFleetManifest {
  const entry = manifest.repositories[repo]
  if (!entry?.slugRotation) throw new Error(`manifest repository has no pending slug rotation: ${repo}`)
  const { slugRotation: _completed, ...completedEntry } = entry
  const next: GitHubFleetManifest = {
    ...manifest,
    version: MANIFEST_VERSION,
    repositories: { ...manifest.repositories, [repo]: completedEntry },
  }
  validateGitHubFleetManifest(next)
  return next
}
