// @vitest-environment node

import { chmod, lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex } from '../../../src/lib/hmac'
import { subscriptionKvKey } from '../../../src/lib/subscription'
import type { GitHubFleetDependencies, GitHubFleetOptions } from '../src/fleet'
import {
  applyGitHubFleet,
  verifyGitHubFleet,
  waitForAuthenticatedGitHubRoute,
  type DesiredHook,
  type GitHubFleetReconcileDependencies,
} from '../src/reconcile'
import {
  githubFleetManifestProfiles,
  serializeGitHubFleetManifest,
  type GitHubFleetManifest,
  type GitHubFleetManifestRepository,
} from '../src/manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  GITHUB_FLEET_PROFILES,
  buildGitHubFleetSubscription,
  githubFleetSubscriptionName,
} from '../src/model'
import { parseGitHubEventSelection } from '../../../scripts/providers/github/event-profiles'
import type { GitHubRepositoryHook } from '../../../scripts/providers/github/repository-hooks'
import { writePrivateText, type AtomicFileSystem, type SecretValue } from '../../../scripts/setup'
import { computePlan, parseRoutes } from '../../../scripts/sync'

const REPO = 'example-owner/example-plugin'
const BASE_URL = 'https://hooks.example.com'

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

function manifestEntry(repo: string, seed: string): GitHubFleetManifestRepository {
  return {
    hmac: {
      name: `HMAC_GITHUB_${repo.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      value: `${seed}-canonical-secret`,
    },
    slugs: {
      activity: `${seed}activityslugvalue00`.slice(0, 22),
      stars: `${seed}starsslugvalue00000`.slice(0, 22),
      alerts: `${seed}alertsslugvalue0000`.slice(0, 22),
    },
    state: 'active',
  }
}

async function subscriptionsFor(manifest: GitHubFleetManifest): Promise<ReturnType<typeof parseRoutes>['subs']> {
  const subscriptions = []
  for (const [repo, entry] of Object.entries(manifest.repositories)) {
    for (const profile of githubFleetManifestProfiles(entry)) {
      const sub = await buildGitHubFleetSubscription(repo, profile, {
        hmacName: entry.hmac.name,
        slugs: entry.slugs,
      })
      subscriptions.push(sub)
    }
  }
  return subscriptions
}

async function writeProject(
  manifest: GitHubFleetManifest,
  fileSystem: AtomicFileSystem,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-reconcile-'))
  const routes = {
    baseUrl: BASE_URL,
    subs: await subscriptionsFor(manifest),
    sinks: [
      { name: 'discord:repo-activity', type: 'discord', urlEnv: 'SINK_ACTIVITY' },
      { name: 'discord:github-stars', type: 'discord', urlEnv: 'SINK_STARS' },
      { name: 'discord:repo-alerts', type: 'discord', urlEnv: 'SINK_ALERTS' },
    ],
  }
  await writeFile(join(directory, 'routes.jsonc'), `${JSON.stringify(routes, null, 2)}\n`)
  await writeFile(join(directory, 'wrangler.jsonc'), '{ "vars": {} }\n')
  await writePrivateText(join(directory, 'fleet.json'), serializeGitHubFleetManifest(manifest), fileSystem)
  const devVars = Object.values(manifest.repositories)
    .map((entry) => `${entry.hmac.name}=${entry.hmac.value}`)
    .join('\n')
  await writePrivateText(join(directory, '.dev.vars'), `${devVars}\n`, fileSystem)
  return directory
}

function fleetOptions(phase: 'apply' | 'verify', repositories: string[] = []): GitHubFleetOptions {
  return {
    phase,
    root: '/repo',
    manifest: 'fleet.json',
    repositories,
    includePrivate: false,
    secretLimit: 64,
    yes: true,
  }
}

function cloneKv(value: { subs: Record<string, string>; sinks: Record<string, string> }) {
  return { subs: { ...value.subs }, sinks: { ...value.sinks } }
}

async function acceptSignedRoute(
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signature = new Headers(init?.headers).get('x-hub-signature-256')
  return new Response('', { status: /^sha256=[0-9a-f]{64}$/.test(signature ?? '') ? 200 : 401 })
}

function hookFor(entry: GitHubFleetManifestRepository, repo: string, profile: keyof typeof GITHUB_FLEET_PROFILES, id: number): GitHubRepositoryHook {
  const events = parseGitHubEventSelection(GITHUB_FLEET_PROFILES[profile].eventProfiles.join(',')).events!
  return {
    id,
    active: true,
    events: [...events],
    config: {
      url: `${BASE_URL}/hook/github/${entry.slugs[profile]}`,
      content_type: 'json',
      insecure_ssl: '0',
    },
  }
}

describe('route propagation probes', () => {
  it('signs the probe and waits through propagation until the route authenticates it', async () => {
    const statuses = [404, 401, 200]
    let now = 0
    const hook: DesiredHook = {
      repo: REPO,
      profile: 'activity',
      subscriptionName: githubFleetSubscriptionName(REPO, 'activity'),
      slugHash: 'a'.repeat(64),
      url: `${BASE_URL}/hook/github/private-slug-value-00`,
      secret: 'private-secret',
      events: ['push'],
    }
    let expectedSignature: string | undefined
    await expect(waitForAuthenticatedGitHubRoute(hook, {
      fetch: async (_input, init) => {
        const body = String(init?.body)
        expectedSignature ??= `sha256=${await hmacSha256Hex(
          hook.secret,
          new TextEncoder().encode(body),
        )}`
        expect(new Headers(init?.headers).get('x-hub-signature-256')).toBe(expectedSignature)
        return new Response('', { status: statuses.shift()! })
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      routeTimeoutMs: 10,
      routeIntervalMs: 2,
    })).resolves.toBeUndefined()
  })

  it('blocks an unexpected signed response without exposing the URL or secret', async () => {
    const hook: DesiredHook = {
      repo: REPO,
      profile: 'activity',
      subscriptionName: githubFleetSubscriptionName(REPO, 'activity'),
      slugHash: 'a'.repeat(64),
      url: `${BASE_URL}/hook/github/private-slug-value-00`,
      secret: 'private-secret',
      events: ['push'],
    }
    let error: Error | undefined
    try {
      await waitForAuthenticatedGitHubRoute(hook, {
        fetch: async () => new Response('', { status: 403 }),
      })
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toMatch(/unexpected status 403/)
    expect(error?.message).not.toContain('private-slug-value-00')
    expect(error?.message).not.toContain('private-secret')
  })
})

describe('GitHub fleet apply and verify', () => {
  it('requires confirmation before any production write', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'confirm')
    const manifest: GitHubFleetManifest = { version: 2, repositories: { [REPO]: entry }, retiredRepositories: {} }
    const directory = await writeProject(manifest, fileSystem)
    try {
      const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
      const sinkSecrets = new Set(['SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS'])
      const putSecrets = vi.fn(async () => new Set(sinkSecrets))
      const putKv = vi.fn(async () => undefined)
      const createHook = vi.fn(async () => 1)
      const readKv = async () => cloneKv(remote)
      const planDependencies: GitHubFleetDependencies = {
        discover: async () => ({ repositories: [{ nameWithOwner: REPO, path: `/repo/${REPO}`, isFork: false }], exclusions: [], blockers: [] }),
        listHooks: async () => [],
        listSecrets: async () => new Set(sinkSecrets),
        readKv,
        fileSystem,
      }
      const applyOptions = { ...fleetOptions('apply', [REPO]), yes: false }
      await expect(applyGitHubFleet(applyOptions, directory, {
        planDependencies,
        confirm: async () => false,
        putSecrets,
        putKv,
        createHook,
        listSecrets: async () => new Set(sinkSecrets),
        readKv,
      })).rejects.toThrow(/cancelled/)
      expect(putSecrets).not.toHaveBeenCalled()
      expect(putKv).not.toHaveBeenCalled()
      expect(createHook).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('applies and verifies only the profiles saved for a repository', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry: GitHubFleetManifestRepository = { ...manifestEntry(REPO, 'alerts-only'), profiles: ['alerts'] }
    const manifest: GitHubFleetManifest = { version: 3, repositories: { [REPO]: entry }, retiredRepositories: {} }
    const directory = await writeProject(manifest, fileSystem)
    try {
      const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
      const secrets = new Set(['SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS'])
      const hooks: GitHubRepositoryHook[] = []
      const readKv = vi.fn(async () => cloneKv(remote))
      const listSecrets = async () => new Set(secrets)
      const planDependencies: GitHubFleetDependencies = {
        discover: async () => ({ repositories: [{ nameWithOwner: REPO, path: `/repo/${REPO}`, isFork: false }], exclusions: [], blockers: [] }),
        listHooks: async () => [...hooks],
        listSecrets,
        readKv,
        fileSystem,
      }
      const dependencies: GitHubFleetReconcileDependencies = {
        planDependencies,
        listHooks: async () => [...hooks],
        createHook: async (_repo, url, _secret, selection) => {
          hooks.push({
            id: 1,
            active: true,
            events: [...selection.events!],
            config: { url, content_type: 'json', insecure_ssl: '0' },
          })
          return 1
        },
        pingHook: async () => ({ id: 'ping-guid', event: 'ping', statusCode: 200, deliveredAt: null }),
        listSecrets,
        putSecrets: async (values) => {
          for (const value of values) secrets.add(value.name)
          return new Set(secrets)
        },
        readKv,
        putKv: async (binding, key, value) => { remote[binding === 'SUBS' ? 'subs' : 'sinks'][key] = value },
        fetch: acceptSignedRoute,
        sleep: async () => undefined,
      }

      await expect(applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)).resolves.toMatchObject({
        reconciledHooks: 1,
      })
      expect(Object.keys(remote.subs)).toHaveLength(1)
      expect(remote.sinks['sink:discord:repo-activity']).toBeUndefined()
      expect(remote.sinks['sink:discord:github-stars']).toBeUndefined()
      expect(hooks).toHaveLength(1)
      readKv.mockClear()
      await expect(verifyGitHubFleet(fleetOptions('verify', [REPO]), directory, dependencies)).resolves.toMatchObject({
        verifiedHooks: 1,
        issues: [],
      })
      expect(readKv).toHaveBeenCalledTimes(1)

      const inactive = await buildGitHubFleetSubscription(REPO, 'activity', {
        hmacName: entry.hmac.name,
        slugs: entry.slugs,
      })
      remote.subs[subscriptionKvKey(inactive.slugHash)] = '{}'
      hooks.push(hookFor(entry, REPO, 'activity', 3))
      const drifted = await verifyGitHubFleet(fleetOptions('verify', [REPO]), directory, dependencies)
      expect(drifted.issues.join('\n')).toMatch(/inactive profile still has.*GitHub hook/)
      expect(drifted.issues.join('\n')).toMatch(/inactive profile still has a production KV route/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes partial hook creation, preserves unrelated hooks, and becomes idempotent', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'canary')
    const manifest: GitHubFleetManifest = { version: 2, repositories: { [REPO]: entry }, retiredRepositories: {} }
    const directory = await writeProject(manifest, fileSystem)
    try {
      const routes = parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))
      const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
      const secrets = new Set<string>(['SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS'])
      const unrelated = {
        id: 900,
        active: true,
        events: ['push'],
        config: { url: 'https://other.example.com/webhook', content_type: 'json', insecure_ssl: '0' },
      }
      const hooks = [unrelated, hookFor(entry, REPO, 'activity', 1)]
      const createHook = vi.fn(async (
        repo: string,
        url: string,
        _secret: string,
        selection: ReturnType<typeof parseGitHubEventSelection>,
      ) => {
        const id = hooks.length + 1
        hooks.push({
          id,
          active: true,
          events: [...selection.events!],
          config: { url, content_type: 'json', insecure_ssl: '0' },
        })
        return id
      })
      const pingHook = vi.fn(async () => ({ id: 'ping-guid', event: 'ping', statusCode: 200, deliveredAt: null }))
      const updateHook = vi.fn(async () => undefined)
      const readKv = async () => cloneKv(remote)
      const listSecrets = async () => new Set(secrets)
      const planDependencies: GitHubFleetDependencies = {
        discover: async () => ({ repositories: [{ nameWithOwner: REPO, path: `/repo/${REPO}`, isFork: false }], exclusions: [], blockers: [] }),
        listHooks: async () => [...hooks],
        listSecrets,
        readKv,
        fileSystem,
      }
      const dependencies: GitHubFleetReconcileDependencies = {
        planDependencies,
        listHooks: async () => [...hooks],
        createHook,
        updateHook,
        pingHook,
        listSecrets,
        putSecrets: async (values) => {
          for (const value of values) secrets.add(value.name)
          return new Set(secrets)
        },
        readKv,
        putKv: async (binding, key, value) => { remote[binding === 'SUBS' ? 'subs' : 'sinks'][key] = value },
        fetch: acceptSignedRoute,
        sleep: async () => undefined,
      }

      const first = await applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)
      expect(first).toMatchObject({ installedSecrets: 1, reconciledHooks: 3 })
      expect(createHook).toHaveBeenCalledTimes(2)
      expect(hooks).toContain(unrelated)
      expect(pingHook).toHaveBeenCalledTimes(3)
      expect(Object.keys(remote.subs)).toHaveLength(3)

      createHook.mockClear()
      pingHook.mockClear()
      const second = await applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)
      expect(second.installedSecrets).toBe(0)
      expect(createHook).not.toHaveBeenCalled()
      expect(pingHook).toHaveBeenCalledTimes(3)

      pingHook.mockClear()
      const verified = await verifyGitHubFleet(fleetOptions('verify', [REPO]), directory, dependencies)
      expect(verified).toMatchObject({ repositories: [REPO], verifiedHooks: 3, issues: [] })
      expect(pingHook).toHaveBeenCalledTimes(3)
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))).toEqual(routes)

      updateHook.mockClear()
      hooks.find((hook) => hook.id === 1)!.active = false
      const drifted = await verifyGitHubFleet(fleetOptions('verify', [REPO]), directory, dependencies)
      expect(drifted.issues.join('\n')).toMatch(/metadata differs/)
      expect(updateHook).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('repairs managed metadata drift and retries an exact hook with a wrong secret', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'repair')
    const manifest: GitHubFleetManifest = { version: 2, repositories: { [REPO]: entry }, retiredRepositories: {} }
    const directory = await writeProject(manifest, fileSystem)
    try {
      const routes = parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))
      const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
      const initialPlan = computePlan(routes, remote)
      for (const put of initialPlan.subPuts) remote.subs[put.key] = put.value
      for (const put of initialPlan.sinkPuts) remote.sinks[put.key] = put.value
      const secrets = new Set([entry.hmac.name, 'SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS'])
      const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hookFor(entry, REPO, profile, index + 1))
      hooks[0]!.active = false
      const updateHook = vi.fn(async (
        _repo: string,
        hookId: number,
        url: string,
        events: readonly string[],
      ) => {
        const hook = hooks.find((candidate) => candidate.id === hookId)!
        hook.active = true
        hook.events = [...events]
        hook.config = { url, content_type: 'json', insecure_ssl: '0' }
      })
      const pingAttempts = new Map<number, number>()
      const pingHook = vi.fn(async (_repo: string, hookId: number) => {
        const attempt = (pingAttempts.get(hookId) ?? 0) + 1
        pingAttempts.set(hookId, attempt)
        if (hookId === 2 && attempt === 1) throw new Error('GitHub webhook 2 returned status 401 for ping')
        return { id: `ping-guid-${attempt}`, event: 'ping', statusCode: 200, deliveredAt: null }
      })
      const readKv = async () => cloneKv(remote)
      const planDependencies: GitHubFleetDependencies = {
        discover: async () => ({ repositories: [{ nameWithOwner: REPO, path: `/repo/${REPO}`, isFork: false }], exclusions: [], blockers: [] }),
        listHooks: async () => [...hooks],
        listSecrets: async () => new Set(secrets),
        readKv,
        fileSystem,
      }
      const dependencies: GitHubFleetReconcileDependencies = {
        planDependencies,
        listHooks: async () => [...hooks],
        createHook: async () => { throw new Error('must not create') },
        updateHook,
        pingHook,
        listSecrets: async () => new Set(secrets),
        readKv,
        putKv: async () => undefined,
        fetch: acceptSignedRoute,
        sleep: async () => undefined,
      }

      await applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)
      expect(updateHook.mock.calls.map((call) => call[1])).toEqual([1, 2])
      expect(pingAttempts.get(2)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rewrites selected Worker secrets and repairs hooks during HMAC rotation', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'rotate')
    const manifest: GitHubFleetManifest = { version: 2, repositories: { [REPO]: entry }, retiredRepositories: {} }
    const directory = await writeProject(manifest, fileSystem)
    try {
      const routes = parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))
      const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
      const initialPlan = computePlan(routes, remote)
      for (const put of initialPlan.subPuts) remote.subs[put.key] = put.value
      for (const put of initialPlan.sinkPuts) remote.sinks[put.key] = put.value
      const secrets = new Set([entry.hmac.name, 'SINK_ACTIVITY', 'SINK_STARS', 'SINK_ALERTS'])
      const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hookFor(entry, REPO, profile, index + 1))
      const putSecrets = vi.fn(async (values: readonly SecretValue[]) => {
        for (const value of values) secrets.add(value.name)
        return new Set(secrets)
      })
      const updateHook = vi.fn(async () => undefined)
      const pingAttempts = new Map<number, number>()
      const pingHook = vi.fn(async (_repo: string, hookId: number) => {
        const attempt = (pingAttempts.get(hookId) ?? 0) + 1
        pingAttempts.set(hookId, attempt)
        if (attempt === 1) throw new Error(`GitHub webhook ${hookId} returned status 401 for ping`)
        return { id: `ping-guid-${attempt}`, event: 'ping', statusCode: 200, deliveredAt: null }
      })
      const readKv = async () => cloneKv(remote)
      const planDependencies: GitHubFleetDependencies = {
        discover: async () => ({ repositories: [{ nameWithOwner: REPO, path: `/repo/${REPO}`, isFork: false }], exclusions: [], blockers: [] }),
        listHooks: async () => [...hooks],
        listSecrets: async () => new Set(secrets),
        readKv,
        fileSystem,
      }
      const dependencies: GitHubFleetReconcileDependencies = {
        planDependencies,
        listHooks: async () => [...hooks],
        createHook: async () => { throw new Error('must not create') },
        updateHook,
        pingHook,
        listSecrets: async () => new Set(secrets),
        putSecrets,
        readKv,
        putKv: async () => undefined,
        fetch: acceptSignedRoute,
        sleep: async () => undefined,
      }

      const result = await applyGitHubFleet(
        { ...fleetOptions('apply', [REPO]), rotateHmac: true },
        directory,
        dependencies,
      )
      expect(result).toMatchObject({ installedSecrets: 0, rotatedSecrets: 1, reconciledHooks: 3 })
      expect(putSecrets).toHaveBeenCalledWith([entry.hmac])
      expect(updateHook).toHaveBeenCalledTimes(3)
      expect([...pingAttempts.values()]).toEqual([2, 2, 2])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
