// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  applyGitHubFleetRetirement,
  planGitHubFleetRetirement,
  prepareGitHubFleetRetirement,
  verifyGitHubFleetRetirement,
  type GitHubFleetRetirementDependencies,
} from '../../scripts/github-fleet-retirement'
import type { GitHubFleetOptions } from '../../scripts/github-fleet'
import {
  githubFleetManifestProfiles,
  parseGitHubFleetManifest,
  type GitHubFleetManifestRepository,
} from '../../scripts/github-fleet-manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  GITHUB_FLEET_PROFILES,
  buildGitHubFleetSubscription,
} from '../../scripts/github-fleet-model'
import { parseGitHubEventSelection } from '../../scripts/github-events'
import type { GitHubRepositoryHook } from '../../scripts/github-repository'
import { readPrivateOptionalText, writePrivateText, writeText } from '../../scripts/setup'
import { computePlan, parseRoutes } from '../../scripts/sync'
import { modeAwareFileSystem } from '../helpers/atomic-file-system'
import type { AtomicFileSystem } from '../../scripts/setup'

const REPO = 'example-owner/example-repo'
const ENTRY: GitHubFleetManifestRepository = {
  hmac: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO', value: 'private-repository-hmac' },
  slugs: {
    activity: 'abcdefghijklmnopqrstuv',
    stars: 'zyxwvutsrqponmlkjihgfe',
    alerts: '0123456789abcdefghijkl',
  },
  state: 'active',
}

function options(phase: GitHubFleetOptions['phase']): GitHubFleetOptions {
  return {
    phase,
    root: '/checkouts',
    manifest: 'fleet.json',
    repositories: [REPO],
    includePrivate: false,
    secretLimit: 64,
    yes: true,
    retire: true,
  }
}

async function fixture(
  fileSystem: AtomicFileSystem,
  entry: GitHubFleetManifestRepository = ENTRY,
): Promise<{ directory: string; routesText: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-fleet-retire-'))
  const subscriptions = []
  for (const profile of githubFleetManifestProfiles(entry)) {
    subscriptions.push(await buildGitHubFleetSubscription(REPO, profile, {
      hmacName: entry.hmac.name,
      slugs: entry.slugs,
    }))
  }
  const routesText = `${JSON.stringify({
    baseUrl: 'https://hooks.example.com',
    subs: subscriptions,
    sinks: [
      { name: 'discord:repo-activity', type: 'discord', urlEnv: 'SINK_ACTIVITY' },
      { name: 'discord:github-stars', type: 'discord', urlEnv: 'SINK_STARS' },
      { name: 'discord:repo-alerts', type: 'discord', urlEnv: 'SINK_ALERTS' },
    ],
  }, null, 2)}\n`
  await writeFile(join(directory, 'routes.jsonc'), routesText)
  await writePrivateText(join(directory, '.dev.vars'), `${entry.hmac.name}=${entry.hmac.value}\n`, fileSystem)
  await writePrivateText(join(directory, 'fleet.json'), `${JSON.stringify({
    version: entry.profiles ? 3 : 2,
    repositories: { [REPO]: entry },
    retiredRepositories: {},
  }, null, 2)}\n`, fileSystem)
  return { directory, routesText }
}

function hook(
  profile: keyof typeof GITHUB_FLEET_PROFILES,
  id: number,
  entry: GitHubFleetManifestRepository = ENTRY,
): GitHubRepositoryHook {
  return {
    id,
    active: true,
    events: [...parseGitHubEventSelection(GITHUB_FLEET_PROFILES[profile].eventProfiles.join(',')).events!],
    config: {
      url: `https://hooks.example.com/hook/github/${entry.slugs[profile]}`,
      content_type: 'json',
      insecure_ssl: '0',
    },
  }
}

function applyPlan(
  routesText: string,
  remote: { subs: Record<string, string>; sinks: Record<string, string> },
): void {
  const plan = computePlan(parseRoutes(routesText), remote)
  for (const put of plan.subPuts) remote.subs[put.key] = put.value
  for (const key of plan.subDeletes) delete remote.subs[key]
  for (const put of plan.sinkPuts) remote.sinks[put.key] = put.value
  for (const key of plan.sinkDeletes) delete remote.sinks[key]
}

function harness(
  directory: string,
  remote: { subs: Record<string, string>; sinks: Record<string, string> },
  hooks: GitHubRepositoryHook[],
  secrets: Set<string>,
  fileSystem: AtomicFileSystem,
  failHookId?: number,
): {
  dependencies: GitHubFleetRetirementDependencies
  deleteHook: ReturnType<typeof vi.fn>
  writes: string[]
  logs: string[]
} {
  const writes: string[] = []
  const logs: string[] = []
  let failed = false
  const deleteHook = vi.fn(async (_repo: string, id: number) => {
    if (id === failHookId && !failed) {
      failed = true
      throw new Error('simulated GitHub interruption')
    }
    const index = hooks.findIndex((candidate) => candidate.id === id)
    if (index >= 0) hooks.splice(index, 1)
  })
  return {
    deleteHook,
    writes,
    logs,
    dependencies: {
      discover: async () => ({
        repositories: [{ nameWithOwner: REPO, path: `/checkouts/${REPO}`, isFork: false }],
        exclusions: [],
        blockers: [],
      }),
      readText: (path) => readFile(path, 'utf8'),
      readPrivateText: (path) => readPrivateOptionalText(path, fileSystem),
      writeText: async (path, text) => {
        writes.push(`text:${path}`)
        await writeText(path, text)
      },
      writePrivateText: async (path, text) => {
        writes.push(`private:${path}`)
        await writePrivateText(path, text, fileSystem)
      },
      readKv: async () => ({ subs: { ...remote.subs }, sinks: { ...remote.sinks } }),
      putKv: async (binding, key, value) => {
        remote[binding === 'SUBS' ? 'subs' : 'sinks'][key] = value
      },
      deleteKv: async (binding, key) => {
        delete remote[binding === 'SUBS' ? 'subs' : 'sinks'][key]
      },
      listHooks: async () => [...hooks],
      deleteHook,
      listSecrets: async () => new Set(secrets),
      deleteSecrets: async (names) => {
        for (const name of names) secrets.delete(name)
        return new Set(secrets)
      },
      fetch: async () => new Response(null, { status: 204 }),
      sleep: async () => undefined,
      now: () => 0,
      nowIso: () => '2026-08-15T12:00:00.000Z',
      routeTimeoutMs: 10,
      routeIntervalMs: 1,
      routeGraceMs: 0,
      confirm: async () => true,
      log: (line) => logs.push(line),
    },
  }
}

describe('GitHub fleet retirement', () => {
  it('retires only the profiles saved for a repository', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry: GitHubFleetManifestRepository = { ...ENTRY, profiles: ['alerts'] }
    const { directory, routesText } = await fixture(fileSystem, entry)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = [hook('alerts', 1, entry)]
    const secrets = new Set([entry.hmac.name])
    const test = harness(directory, remote, hooks, secrets, fileSystem)
    try {
      await expect(planGitHubFleetRetirement(options('plan'), test.dependencies, directory)).resolves.toMatchObject({
        blockers: [],
        routesToDisable: [`github:${REPO}:alerts`],
      })
      await expect(prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)).resolves.toMatchObject({
        disabledSubscriptions: 1,
      })
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).resolves.toMatchObject({
        deletedHooks: 1,
        deletedRoutes: 1,
        deletedSecrets: 1,
      })
      await expect(verifyGitHubFleetRetirement(options('verify'), test.dependencies, directory)).resolves.toMatchObject({
        issues: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('upgrades, disables, deletes exact owned state, and verifies without pinging', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    hooks.push({
      id: 99,
      active: true,
      events: ['push'],
      config: { url: 'https://unrelated.example/hook', content_type: 'json', insecure_ssl: '0' },
    })
    const secrets = new Set([ENTRY.hmac.name])
    const test = harness(directory, remote, hooks, secrets, fileSystem)
    try {
      const initial = await planGitHubFleetRetirement(options('plan'), test.dependencies, directory)
      expect(initial).toMatchObject({ blockers: [], active: [REPO] })
      expect(initial.routesToDisable).toHaveLength(3)

      const prepared = await prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)
      expect(prepared.disabledSubscriptions).toBe(3)
      expect(test.writes[0]).toBe(`private:${join(directory, 'fleet.json')}`)
      const stagedManifest = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(stagedManifest).toMatchObject({
        version: 2,
        repositories: { [REPO]: { state: 'retiring' } },
      })
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).subs.every((sub) => !sub.enabled)).toBe(true)
      expect(Object.values(remote.subs).every((value) => JSON.parse(value).enabled)).toBe(true)

      const applied = await applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)
      expect(applied).toMatchObject({ deletedHooks: 3, deletedRoutes: 3, deletedSecrets: 1 })
      expect(hooks.map((candidate) => candidate.id)).toEqual([99])
      expect(remote.subs).toEqual({})
      expect(secrets.has(ENTRY.hmac.name)).toBe(false)
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).subs).toEqual([])
      const retiredManifest = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(retiredManifest.repositories[REPO]).toBeUndefined()
      expect(retiredManifest.retiredRepositories[REPO]).toMatchObject({ hmac: ENTRY.hmac, slugs: ENTRY.slugs })
      expect(test.logs.join('\n')).not.toContain(ENTRY.hmac.value)

      await expect(verifyGitHubFleetRetirement(options('verify'), test.dependencies, directory)).resolves.toEqual({
        repositories: [REPO],
        issues: [],
      })
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).resolves.toMatchObject({
        deletedHooks: 0,
        deletedRoutes: 0,
        deletedSecrets: 0,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes hook deletion from manifest phase markers after a partial failure', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    const test = harness(directory, remote, hooks, new Set([ENTRY.hmac.name]), fileSystem, 2)
    try {
      await prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).rejects.toThrow(/interruption/)
      const interrupted = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(interrupted.repositories[REPO]?.retirement?.hooks.activity?.deleted).toBe(true)
      expect(interrupted.repositories[REPO]?.retirement?.hooks.stars?.deleted).toBe(false)
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).resolves.toMatchObject({
        deletedHooks: 2,
        deletedRoutes: 3,
      })
      expect(test.deleteHook.mock.calls.filter((call) => call[1] === 1)).toHaveLength(1)
      expect(hooks).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not recreate deleted KV routes when secret cleanup is retried', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    const secrets = new Set([ENTRY.hmac.name])
    const test = harness(directory, remote, hooks, secrets, fileSystem)
    const deleteSecretsDependency = test.dependencies.deleteSecrets
    let failSecretDeletion = true
    test.dependencies.deleteSecrets = async (names) => {
      if (failSecretDeletion) {
        failSecretDeletion = false
        throw new Error('simulated secret cleanup interruption')
      }
      return deleteSecretsDependency(names)
    }
    try {
      await prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).rejects.toThrow(/secret cleanup interruption/)
      const interrupted = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(interrupted.repositories[REPO]?.retirement?.kvRemoved).toBe(true)
      expect(remote.subs).toEqual({})
      await expect(applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)).resolves.toMatchObject({
        deletedRoutes: 0,
        deletedSecrets: 1,
      })
      expect(remote.subs).toEqual({})
      await expect(verifyGitHubFleetRetirement(options('verify'), test.dependencies, directory)).resolves.toEqual({
        repositories: [REPO],
        issues: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes preparation after the manifest write succeeds and the route write fails', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    const test = harness(directory, remote, hooks, new Set([ENTRY.hmac.name]), fileSystem)
    const writeTextDependency = test.dependencies.writeText
    let failRouteWrite = true
    test.dependencies.writeText = async (path, text) => {
      if (failRouteWrite && path === join(directory, 'routes.jsonc')) {
        failRouteWrite = false
        throw new Error('simulated route write interruption')
      }
      await writeTextDependency(path, text)
    }
    try {
      await expect(prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)).rejects.toThrow(/route write interruption/)
      const interrupted = parseGitHubFleetManifest(await readFile(join(directory, 'fleet.json'), 'utf8'))
      expect(interrupted.repositories[REPO]?.state).toBe('retiring')
      const recoveryPlan = await planGitHubFleetRetirement(options('plan'), test.dependencies, directory)
      expect(recoveryPlan).toMatchObject({ blockers: [] })
      expect(recoveryPlan.routesToDisable).toHaveLength(3)
      await expect(prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)).resolves.toMatchObject({
        disabledSubscriptions: 3,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains a repository HMAC that another route still references', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const routes = parseRoutes(routesText)
    routes.subs.push({
      name: 'shared-automation',
      source: 'cloudevents',
      slugHash: 'c'.repeat(64),
      enabled: false,
      sinks: ['discord:repo-activity'],
      auth: { scheme: 'hookrelay-sha256', secretEnv: ENTRY.hmac.name },
    })
    const sharedRoutesText = `${JSON.stringify(routes, null, 2)}\n`
    await writeFile(join(directory, 'routes.jsonc'), sharedRoutesText)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(sharedRoutesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    const secrets = new Set([ENTRY.hmac.name])
    const test = harness(directory, remote, hooks, secrets, fileSystem)
    try {
      const plan = await planGitHubFleetRetirement(options('plan'), test.dependencies, directory)
      expect(plan.secretsToDelete).toEqual([])
      await prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)
      await applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)
      expect(secrets.has(ENTRY.hmac.name)).toBe(true)
      expect(await readFile(join(directory, '.dev.vars'), 'utf8')).toContain(`${ENTRY.hmac.name}=`)
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).subs.map((sub) => sub.name)).toEqual([
        'shared-automation',
      ])
      await expect(verifyGitHubFleetRetirement(options('verify'), test.dependencies, directory)).resolves.toEqual({
        repositories: [REPO],
        issues: [],
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('redacts private route values from propagation failures', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hook(profile, index + 1))
    const test = harness(directory, remote, hooks, new Set([ENTRY.hmac.name]), fileSystem)
    try {
      await prepareGitHubFleetRetirement(options('prepare'), test.dependencies, directory)
      test.dependencies.fetch = async () => {
        throw new Error(`network failure for ${ENTRY.slugs.activity}`)
      }
      let error: Error | undefined
      try {
        await applyGitHubFleetRetirement(options('apply'), test.dependencies, directory)
      } catch (caught) {
        error = caught as Error
      }
      expect(error?.message).toMatch(/disabled route probe failed/)
      expect(error?.message).not.toContain(ENTRY.slugs.activity)
      expect(error?.message).not.toContain(ENTRY.hmac.value)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
