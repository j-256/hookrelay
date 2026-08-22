import { execFile } from 'node:child_process'
import { opendir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  assertGitHubFleetRepositoryCollisions,
  type GitHubFleetProgress,
} from './model'

const execFileP = promisify(execFile)

const GITHUB_PRIVATE_VISIBILITY = 'PRIVATE'
const GITHUB_PUBLIC_VISIBILITY = 'PUBLIC'

export interface GitHubFleetRepository {
  nameWithOwner: string
  path: string
  isFork: boolean
}

export interface GitHubFleetDiscoveryExclusion {
  child: string
  reason: string
}

export interface GitHubFleetDiscovery {
  repositories: GitHubFleetRepository[]
  exclusions: GitHubFleetDiscoveryExclusion[]
  blockers: string[]
}

export interface GitHubFleetDiscoveryOptions {
  privateRepositories?: ReadonlySet<string>
  progress?: GitHubFleetProgress
}

export type GitHubFleetCommandRunner = (command: string, args: string[]) => Promise<string>

const defaultRunner: GitHubFleetCommandRunner = async (command, args) => {
  const { stdout } = await execFileP(command, args, { encoding: 'utf8' })
  return stdout
}

interface GitHubRepositoryMetadata {
  nameWithOwner: string
  visibility: string
  isArchived: boolean
  isFork: boolean
  viewerPermission: string
}

function stripGitSuffix(path: string): string {
  return path.endsWith('.git') ? path.slice(0, -4) : path
}

function repositoryFromPath(path: string): string | null {
  const normalized = stripGitSuffix(path.replace(/^\/+|\/+$/g, ''))
  return /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(normalized) ? normalized : null
}

export function parseGitHubOrigin(remote: string): string | null {
  const value = remote.trim()
  const scp = /^(?:[^@\s]+@)?github\.com:(.+)$/i.exec(value)
  if (scp) return repositoryFromPath(scp[1]!)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null
  if (!['https:', 'ssh:', 'git:'].includes(url.protocol)) return null
  return repositoryFromPath(url.pathname)
}

function referencesGitHubHost(remote: string): boolean {
  const value = remote.trim()
  if (/^(?:[^@\s]+@)?github\.com:/i.test(value)) return true
  try {
    return new URL(value).hostname.toLowerCase() === 'github.com'
  } catch {
    return false
  }
}

function parseRepositoryMetadata(text: string): GitHubRepositoryMetadata {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('GitHub returned malformed repository metadata')
  }
  if (value === null || typeof value !== 'object') throw new Error('GitHub returned invalid repository metadata')
  const record = value as Record<string, unknown>
  if (
    typeof record.nameWithOwner !== 'string'
    || typeof record.visibility !== 'string'
    || typeof record.isArchived !== 'boolean'
    || typeof record.isFork !== 'boolean'
    || typeof record.viewerPermission !== 'string'
  ) {
    throw new Error('GitHub returned invalid repository metadata')
  }
  return record as unknown as GitHubRepositoryMetadata
}

async function childNames(root: string): Promise<string[]> {
  const directory = await opendir(root)
  const names: string[] = []
  for await (const entry of directory) names.push(entry.name)
  return names.sort((left, right) => left.localeCompare(right))
}

export async function discoverGitHubFleet(
  root: string,
  options: GitHubFleetDiscoveryOptions = {},
  runner: GitHubFleetCommandRunner = defaultRunner,
): Promise<GitHubFleetDiscovery> {
  const resolvedRoot = await realpath(root)
  const repositories: GitHubFleetRepository[] = []
  const exclusions: GitHubFleetDiscoveryExclusion[] = []
  const blockers: string[] = []
  const canonicalOwners = new Map<string, string>()

  const children = await childNames(resolvedRoot)
  for (const [index, child] of children.entries()) {
    options.progress?.(`Inspecting repository checkout ${index + 1}/${children.length}`)
    const childPath = join(resolvedRoot, child)
    let info
    try {
      info = await stat(childPath)
    } catch {
      exclusions.push({ child, reason: 'unreadable directory entry' })
      continue
    }
    if (!info.isDirectory()) {
      exclusions.push({ child, reason: 'not a directory' })
      continue
    }

    let topLevel: string
    try {
      topLevel = (await runner('git', ['-C', childPath, 'rev-parse', '--show-toplevel'])).trim()
    } catch {
      exclusions.push({ child, reason: 'not a Git worktree' })
      continue
    }
    let resolvedTopLevel: string
    try {
      resolvedTopLevel = await realpath(topLevel)
    } catch {
      blockers.push(`${child}: Git reported an unreadable worktree root`)
      continue
    }
    if (resolvedTopLevel !== await realpath(childPath)) {
      exclusions.push({ child, reason: 'not a direct-child Git worktree root' })
      continue
    }

    let remote: string
    try {
      remote = (await runner('git', ['-C', childPath, 'remote', 'get-url', 'origin'])).trim()
    } catch {
      exclusions.push({ child, reason: 'origin remote is missing' })
      continue
    }
    const remoteRepo = parseGitHubOrigin(remote)
    if (!remoteRepo) {
      if (referencesGitHubHost(remote)) blockers.push(`${child}: malformed GitHub origin`)
      else exclusions.push({ child, reason: 'origin is not GitHub' })
      continue
    }

    let metadata: GitHubRepositoryMetadata
    try {
      metadata = parseRepositoryMetadata(await runner('gh', [
        'repo',
        'view',
        remoteRepo,
        '--json',
        'nameWithOwner,visibility,isArchived,isFork,viewerPermission',
      ]))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      blockers.push(`${remoteRepo}: metadata lookup failed (${message})`)
      continue
    }
    const selectedPrivateRepository = metadata.visibility === GITHUB_PRIVATE_VISIBILITY
      && options.privateRepositories?.has(metadata.nameWithOwner) === true
    if (metadata.visibility !== GITHUB_PUBLIC_VISIBILITY && !selectedPrivateRepository) {
      exclusions.push({ child, reason: `GitHub visibility is ${metadata.visibility.toLowerCase()}` })
      continue
    }
    if (metadata.isArchived) {
      blockers.push(`${metadata.nameWithOwner}: repository is archived`)
      continue
    }
    if (metadata.viewerPermission !== 'ADMIN') {
      blockers.push(`${metadata.nameWithOwner}: admin permission is required`)
      continue
    }
    const previousChild = canonicalOwners.get(metadata.nameWithOwner)
    if (previousChild) {
      blockers.push(`${metadata.nameWithOwner}: discovered from both ${previousChild} and ${child}`)
      continue
    }
    canonicalOwners.set(metadata.nameWithOwner, child)
    repositories.push({ nameWithOwner: metadata.nameWithOwner, path: childPath, isFork: metadata.isFork })
  }

  repositories.sort((left, right) => left.nameWithOwner.localeCompare(right.nameWithOwner))
  try {
    assertGitHubFleetRepositoryCollisions(repositories.map((repo) => repo.nameWithOwner))
  } catch (err) {
    blockers.push(err instanceof Error ? err.message : String(err))
  }
  return { repositories, exclusions, blockers }
}
