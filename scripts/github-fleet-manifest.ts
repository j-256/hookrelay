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

const MANIFEST_VERSION = 1
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

const repositorySchema = z.object({
  hmac: secretSchema,
  slugs: slugsSchema,
}).strict()

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  repositories: z.record(z.string().regex(REPOSITORY_RE), repositorySchema),
}).strict()

export type GitHubFleetSecret = z.infer<typeof secretSchema>
export type GitHubFleetManifestRepository = z.infer<typeof repositorySchema>
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
  return { version: MANIFEST_VERSION, repositories: {} }
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
  const repositories = Object.keys(manifest.repositories)
  assertGitHubFleetRepositoryCollisions(repositories)
  const slugOwners = new Map<string, string>()
  const hmacValueOwners = new Map<string, string>()

  for (const repo of repositories) {
    const entry = manifest.repositories[repo]!
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
  for (const repo of Object.keys(manifest.repositories).sort()) {
    const entry = manifest.repositories[repo]!
    repositories[repo] = {
      hmac: entry.hmac,
      slugs: {
        activity: entry.slugs.activity,
        stars: entry.slugs.stars,
        alerts: entry.slugs.alerts,
      },
    }
  }
  return `${JSON.stringify({ version: MANIFEST_VERSION, repositories }, null, 2)}\n`
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
  }
  validateGitHubFleetManifest(next)
  return next
}

export function githubFleetManifestValues(entry: GitHubFleetManifestRepository): GitHubFleetValues {
  return {
    hmacName: entry.hmac.name,
    slugs: { ...entry.slugs } as Record<GitHubFleetProfileName, string>,
  }
}
