// @vitest-environment node

import { chmod, lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  formatGitHubFleetPlan,
  parseGitHubFleetArgs,
  planGitHubFleet,
  prepareGitHubFleet,
  type GitHubFleetDependencies,
  type GitHubFleetOptions,
} from '../../scripts/github-fleet'
import { parseGitHubFleetManifest, serializeGitHubFleetManifest } from '../../scripts/github-fleet-manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  buildGitHubFleetSubscription,
} from '../../scripts/github-fleet-model'
import {
  githubFleetManifestValues,
  type GitHubFleetManifestRepository,
} from '../../scripts/github-fleet-manifest'
import type { GitHubRepositoryHook } from '../../scripts/github-repository'
import { writePrivateText } from '../../scripts/setup'
import type { AtomicFileSystem } from '../../scripts/setup'

const REPO = 'example-owner/example-plugin'
const OTHER_REPO = 'example-owner/example-repo'
const HMAC_VALUE = 'fixture-hmac-value-that-must-stay-private'
const SLUGS = {
  activity: 'abcdefghijklmnopqrstuv',
  stars: 'zyxwvutsrqponmlkjihgfe',
  alerts: '0123456789abcdefghijkl',
}

function modeAwareFileSystem(): AtomicFileSystem {
  const modes = new Map<string, number>()
  return {
    open,
    chmod: async (path, mode) => {
      modes.set(path, mode)
      await chmod(path, mode)
    },
    lstat: async (path) => {
      const info = await lstat(path)
      const mode = modes.get(path)
      return mode === undefined ? info : {
        mode: (info.mode & ~0o777) | mode,
        isFile: () => info.isFile(),
        isSymbolicLink: () => info.isSymbolicLink(),
      }
    },
    rename: async (source, target) => {
      await rename(source, target)
      const mode = modes.get(source)
      if (mode !== undefined) {
        modes.delete(source)
        modes.set(target, mode)
      }
    },
    unlink: async (path) => {
      modes.delete(path)
      await unlink(path)
    },
  }
}

const TEST_FILE_SYSTEM = modeAwareFileSystem()

function routesText(subs: unknown[] = []): string {
  return `${JSON.stringify({
    baseUrl: 'https://hooks.example.com',
    subs,
    sinks: [
      { name: 'discord:repo-activity', type: 'discord', urlEnv: 'SINK_ACTIVITY' },
      { name: 'discord:github-stars', type: 'discord', urlEnv: 'SINK_STARS' },
      { name: 'discord:repo-alerts', type: 'discord', urlEnv: 'SINK_ALERTS' },
    ],
  }, null, 2)}\n`
}

async function project(subs: unknown[] = [], devVars = ''): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-fleet-'))
  await writeFile(join(directory, 'routes.jsonc'), routesText(subs))
  await writeFile(join(directory, 'wrangler.jsonc'), '{ "vars": { "ENVIRONMENT": "test", "OTHER": "value" } }\n')
  if (devVars) await writePrivateText(join(directory, '.dev.vars'), devVars, TEST_FILE_SYSTEM)
  return directory
}

function options(repositories: string[] = []): GitHubFleetOptions {
  return {
    phase: 'prepare',
    root: '/ignored',
    manifest: 'fleet.json',
    repositories,
    secretLimit: 64,
    yes: false,
  }
}

function dependencies(repositories = [REPO]): GitHubFleetDependencies {
  const slugQueue = [...Object.values(SLUGS)]
  return {
    discover: async () => ({
      repositories: repositories.map((nameWithOwner) => ({ nameWithOwner, path: `/repo/${nameWithOwner}`, isFork: false })),
      exclusions: [],
      blockers: [],
    }),
    listHooks: async () => [],
    listSecrets: async () => new Set(['EXISTING_SECRET', 'SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS']),
    readKv: async () => ({ subs: {}, sinks: {} }),
    randomValues: {
      hmac: () => HMAC_VALUE,
      slug: () => slugQueue.shift()!,
    },
    fileSystem: TEST_FILE_SYSTEM,
  }
}

describe('GitHub fleet arguments', () => {
  it('requires an explicit phase, root, and manifest', () => {
    expect(parseGitHubFleetArgs(['plan', '--root', '/repo', '--manifest', '/secure/fleet.json'])).toMatchObject({
      phase: 'plan',
      root: '/repo',
      manifest: '/secure/fleet.json',
      secretLimit: 64,
    })
    expect(() => parseGitHubFleetArgs(['plan', '--root', '/repo'])).toThrow(/manifest/)
    expect(() => parseGitHubFleetArgs(['prepare', '--root', '/repo', '--manifest', 'fleet.json', '-y'])).toThrow(/only valid/)
  })

  it('accepts repeatable repository filters and a capacity override', () => {
    expect(parseGitHubFleetArgs([
      'apply', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--repo', OTHER_REPO,
      '--secret-limit', '80', '-y',
    ])).toMatchObject({ repositories: [REPO, OTHER_REPO], secretLimit: 80, yes: true })
  })
})

describe('GitHub fleet planning and preparation', () => {
  it('plans selected additions read-only with capacity accounting and secret-free output', async () => {
    const directory = await project()
    try {
      const planOptions = { ...options([REPO]), phase: 'plan' as const }
      const plan = await planGitHubFleet(planOptions, dependencies([OTHER_REPO, REPO]), directory)
      expect(plan.selected).toEqual([REPO])
      expect(plan.manifestAdditions).toEqual([REPO])
      expect(plan.subscriptionAdditions).toHaveLength(3)
      expect(plan.hookAdditions).toHaveLength(3)
      expect(plan.capacity).toMatchObject({ vars: 2, existingSecrets: 4, plannedSecrets: 1, projected: 7 })
      const output = formatGitHubFleetPlan(plan)
      expect(output).not.toContain(HMAC_VALUE)
      expect(output).not.toContain(SLUGS.activity)
      await expect(readFile(join(directory, 'fleet.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes the manifest first, then private dev vars and additive routes without regenerating', async () => {
    const directory = await project()
    try {
      const deps = dependencies()
      const first = await prepareGitHubFleet(options(), deps, directory)
      expect(first).toMatchObject({ manifestAdditions: 1, devVarAdditions: 1, subscriptionAdditions: 3 })
      const manifestText = await readFile(join(directory, 'fleet.json'), 'utf8')
      const devVarsText = await readFile(join(directory, '.dev.vars'), 'utf8')
      const preparedRoutes = await readFile(join(directory, 'routes.jsonc'), 'utf8')
      expect(parseGitHubFleetManifest(manifestText).repositories[REPO]?.hmac.value).toBe(HMAC_VALUE)
      expect(devVarsText).toContain('HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_PLUGIN=')
      expect(preparedRoutes).not.toContain(HMAC_VALUE)
      expect((await TEST_FILE_SYSTEM.lstat(join(directory, 'fleet.json'))).mode & 0o777).toBe(0o600)
      expect((await TEST_FILE_SYSTEM.lstat(join(directory, '.dev.vars'))).mode & 0o777).toBe(0o600)

      const second = await prepareGitHubFleet(options(), dependencies(), directory)
      expect(second).toMatchObject({ manifestAdditions: 0, devVarAdditions: 0, subscriptionAdditions: 0 })
      expect(await readFile(join(directory, 'fleet.json'), 'utf8')).toBe(manifestText)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('repairs an interrupted prepare from saved manifest values', async () => {
    const directory = await project()
    try {
      const entry: GitHubFleetManifestRepository = {
        hmac: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_PLUGIN', value: HMAC_VALUE },
        slugs: SLUGS,
      }
      await writePrivateText(
        join(directory, 'fleet.json'),
        serializeGitHubFleetManifest({ version: 1, repositories: { [REPO]: entry } }),
        TEST_FILE_SYSTEM,
      )
      const result = await prepareGitHubFleet(options(), dependencies(), directory)
      expect(result).toMatchObject({ manifestAdditions: 0, devVarAdditions: 1, subscriptionAdditions: 3 })
      expect(await readFile(join(directory, '.dev.vars'), 'utf8'))
        .toContain('HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_PLUGIN=')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports permissive secret files during a read-only plan', async () => {
    const directory = await project()
    try {
      await writeFile(join(directory, 'fleet.json'), '{}')
      const deps = dependencies()
      deps.fileSystem = {
        ...TEST_FILE_SYSTEM,
        lstat: async (path) => {
          const info = await TEST_FILE_SYSTEM.lstat(path)
          return path.endsWith('fleet.json') ? {
            mode: (info.mode & ~0o777) | 0o644,
            isFile: () => info.isFile(),
            isSymbolicLink: () => info.isSymbolicLink(),
          } : info
        },
      }
      const plan = await planGitHubFleet({ ...options(), phase: 'plan' }, deps, directory)
      expect(plan.blockers.join('\n')).toMatch(/mode 0600/)
      expect(await readFile(join(directory, 'fleet.json'), 'utf8')).toBe('{}')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks preparation before writes when projected capacity exceeds the limit', async () => {
    const directory = await project()
    try {
      const limited = { ...options(), secretLimit: 3 }
      await expect(prepareGitHubFleet(limited, dependencies(), directory)).rejects.toThrow(/exceed limit/)
      await expect(readFile(join(directory, 'fleet.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(directory, '.dev.vars'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('existing GitHub fleet import', () => {
  it('recovers route slugs and the canonical HMAC without a separate ledger', async () => {
    const canonical: GitHubFleetManifestRepository = {
      hmac: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO', value: 'canonical-site-secret' },
      slugs: SLUGS,
    }
    const subscriptions = await Promise.all(GITHUB_FLEET_PROFILE_NAMES.map((profile) => (
      buildGitHubFleetSubscription(OTHER_REPO, profile, githubFleetManifestValues(canonical))
    )))
    const directory = await project(subscriptions, 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO=canonical-site-secret\n')
    try {
      const hooks: GitHubRepositoryHook[] = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => ({
        id: index + 1,
        active: true,
        events: [],
        config: {
          url: `https://hooks.example.com/hook/github/${SLUGS[profile]}`,
          content_type: 'json',
          insecure_ssl: '0',
        },
      }))
      const deps = dependencies([OTHER_REPO])
      deps.listHooks = async () => hooks
      deps.randomValues = {
        hmac: () => { throw new Error('must not generate') },
        slug: () => { throw new Error('must not generate') },
      }
      const result = await prepareGitHubFleet(options(), deps, directory)
      expect(result.subscriptionAdditions).toBe(0)
      const manifest = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(manifest.repositories[OTHER_REPO]).toEqual(canonical)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
