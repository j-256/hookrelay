// @vitest-environment node

import { chmod, lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { subscriptionKvKey } from '../../src/lib/subscription'
import type { GitHubFleetDependencies, GitHubFleetOptions } from '../../scripts/github-fleet'
import {
  applyGitHubFleet,
  consolidateSiteHmacs,
  verifyGitHubFleet,
  waitForUnsignedGitHubRoute,
  type DesiredHook,
  type GitHubFleetReconcileDependencies,
} from '../../scripts/github-fleet-reconcile'
import {
  parseGitHubFleetManifest,
  serializeGitHubFleetManifest,
  type GitHubFleetManifest,
  type GitHubFleetManifestRepository,
} from '../../scripts/github-fleet-manifest'
import {
  GITHUB_FLEET_PROFILE_NAMES,
  GITHUB_FLEET_PROFILES,
  buildGitHubFleetSubscription,
  githubFleetSubscriptionName,
} from '../../scripts/github-fleet-model'
import { parseGitHubEventSelection } from '../../scripts/github-events'
import type { GitHubRepositoryHook } from '../../scripts/github-repository'
import { writePrivateText, type AtomicFileSystem, type SecretValue } from '../../scripts/setup'
import { computePlan, parseRoutes, type Routes } from '../../scripts/sync'

const REPO = 'example-owner/example-plugin'
const SITE_REPO = 'example-owner/example-repo'
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
  }
}

async function subscriptionsFor(
  manifest: GitHubFleetManifest,
  authOverrides: Partial<Record<string, { secretEnv: string; alternateSecretEnvs?: string[] }>> = {},
): Promise<ReturnType<typeof parseRoutes>['subs']> {
  const subscriptions = []
  for (const [repo, entry] of Object.entries(manifest.repositories)) {
    for (const profile of GITHUB_FLEET_PROFILE_NAMES) {
      const sub = await buildGitHubFleetSubscription(repo, profile, {
        hmacName: entry.hmac.name,
        slugs: entry.slugs,
      })
      const override = authOverrides[sub.name]
      if (override) sub.auth = { scheme: 'github-sha256', ...override }
      subscriptions.push(sub)
    }
  }
  return subscriptions
}

async function writeProject(
  manifest: GitHubFleetManifest,
  fileSystem: AtomicFileSystem,
  authOverrides: Partial<Record<string, { secretEnv: string; alternateSecretEnvs?: string[] }>> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-reconcile-'))
  const routes = {
    baseUrl: BASE_URL,
    subs: await subscriptionsFor(manifest, authOverrides),
    sinks: [
      { name: 'discord:repo-activity', type: 'discord', urlEnv: 'SINK_ACTIVITY' },
      { name: 'discord:github-stars', type: 'discord', urlEnv: 'SINK_STARS' },
      { name: 'discord:repo-alerts', type: 'discord', urlEnv: 'SINK_ALERTS' },
    ],
  }
  await writeFile(join(directory, 'routes.jsonc'), `${JSON.stringify(routes, null, 2)}\n`)
  await writeFile(join(directory, 'wrangler.jsonc'), '{ "vars": {} }\n')
  await writePrivateText(join(directory, 'fleet.json'), serializeGitHubFleetManifest(manifest), fileSystem)
  const devVars = Object.values(manifest.repositories).flatMap((entry) => [
    `${entry.hmac.name}=${entry.hmac.value}`,
    ...Object.values(entry.retiringHmacs ?? {}).map((retiring) => `${retiring.name}=${retiring.value}`),
  ]).join('\n')
  await writePrivateText(join(directory, '.dev.vars'), `${devVars}\n`, fileSystem)
  return directory
}

function fleetOptions(phase: 'apply' | 'verify', repositories: string[] = []): GitHubFleetOptions {
  return {
    phase,
    root: '/repo',
    manifest: 'fleet.json',
    repositories,
    secretLimit: 64,
    yes: true,
  }
}

function cloneKv(value: { subs: Record<string, string>; sinks: Record<string, string> }) {
  return { subs: { ...value.subs }, sinks: { ...value.sinks } }
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
  it('waits through 404 until an unsigned route reaches GitHub authentication', async () => {
    const statuses = [404, 404, 401]
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
    await expect(waitForUnsignedGitHubRoute(hook, {
      fetch: async () => new Response('', { status: statuses.shift()! }),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
      routeTimeoutMs: 10,
      routeIntervalMs: 2,
    })).resolves.toBeUndefined()
  })

  it('blocks an unexpected unsigned success without exposing the URL or secret', async () => {
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
      await waitForUnsignedGitHubRoute(hook, { fetch: async () => new Response('', { status: 200 }) })
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toMatch(/unexpected status 200/)
    expect(error?.message).not.toContain('private-slug-value-00')
    expect(error?.message).not.toContain('private-secret')
  })
})

describe('GitHub fleet apply and verify', () => {
  it('requires confirmation before any production write', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'confirm')
    const manifest: GitHubFleetManifest = { version: 1, repositories: { [REPO]: entry } }
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

  it('resumes partial hook creation, preserves unrelated hooks, and becomes idempotent', async () => {
    const fileSystem = modeAwareFileSystem()
    const entry = manifestEntry(REPO, 'canary')
    const manifest: GitHubFleetManifest = { version: 1, repositories: { [REPO]: entry } }
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
        fetch: async () => new Response('', { status: 401 }),
        sleep: async () => undefined,
      }

      const first = await applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)
      expect(first).toMatchObject({ installedSecrets: 1, reconciledHooks: 3, siteConsolidated: false })
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
    const manifest: GitHubFleetManifest = { version: 1, repositories: { [REPO]: entry } }
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
        fetch: async () => new Response('', { status: 401 }),
        sleep: async () => undefined,
      }

      await applyGitHubFleet(fleetOptions('apply', [REPO]), directory, dependencies)
      expect(updateHook.mock.calls.map((call) => call[1])).toEqual([1, 2])
      expect(pingAttempts.get(2)).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function siteManifest(): GitHubFleetManifest {
  const entry = manifestEntry(SITE_REPO, 'site00')
  entry.retiringHmacs = {
    stars: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS', value: 'site-retiring-stars-secret' },
    alerts: { name: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_ALERTS', value: 'site-retiring-alerts-secret' },
  }
  return { version: 1, repositories: { [SITE_REPO]: entry } }
}

async function siteHarness(remoteRetiringSecrets: boolean, expandedRoutes = false) {
  const fileSystem = modeAwareFileSystem()
  const manifest = siteManifest()
  const entry = manifest.repositories[SITE_REPO]!
  const overrides = {
    [githubFleetSubscriptionName(SITE_REPO, 'stars')]: {
      secretEnv: entry.retiringHmacs!.stars!.name,
      ...(expandedRoutes ? { alternateSecretEnvs: [entry.hmac.name] } : {}),
    },
    [githubFleetSubscriptionName(SITE_REPO, 'alerts')]: {
      secretEnv: entry.retiringHmacs!.alerts!.name,
      ...(expandedRoutes ? { alternateSecretEnvs: [entry.hmac.name] } : {}),
    },
  }
  const directory = await writeProject(manifest, fileSystem, overrides)
  const routes = parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))
  const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
  for (const put of computePlan(routes, remote).subPuts) remote.subs[put.key] = put.value
  const secretValues = new Map<string, string>([
    [entry.hmac.name, entry.hmac.value],
    ...Object.values(entry.retiringHmacs!).map((retiring) => [retiring.name, retiring.value] as [string, string]),
  ])
  const remoteSecretNames = new Set([entry.hmac.name])
  if (remoteRetiringSecrets) {
    for (const retiring of Object.values(entry.retiringHmacs!)) remoteSecretNames.add(retiring.name)
  }
  const hooks = GITHUB_FLEET_PROFILE_NAMES.map((profile, index) => hookFor(entry, SITE_REPO, profile, index + 1))
  const authTransitions: Array<{ subscription: string; secretEnv: string; alternates: string[] }> = []
  const putKv = async (_binding: string, key: string, value: string) => {
    remote.subs[key] = value
    const parsed = JSON.parse(value) as { name: string; auth: { secretEnv: string; alternateSecretEnvs?: string[] } }
    authTransitions.push({
      subscription: parsed.name,
      secretEnv: parsed.auth.secretEnv,
      alternates: parsed.auth.alternateSecretEnvs ?? [],
    })
  }
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const slug = new URL(request.url).pathname.split('/').at(-1)!
    const profile = GITHUB_FLEET_PROFILE_NAMES.find((candidate) => entry.slugs[candidate] === slug)!
    const sub = namedRoute(routes, profile)
    const key = subscriptionKvKey(sub.slugHash)
    const remoteSub = remote.subs[key]
    if (!remoteSub) return new Response('', { status: 404 })
    const provided = request.headers.get('x-hub-signature-256')?.replace('sha256=', '')
    if (!provided) return new Response('', { status: 401 })
    const body = new Uint8Array(await request.arrayBuffer())
    const auth = (JSON.parse(remoteSub) as { auth: { secretEnv: string; alternateSecretEnvs?: string[] } }).auth
    for (const name of [auth.secretEnv, ...(auth.alternateSecretEnvs ?? [])]) {
      if (!remoteSecretNames.has(name)) continue
      const value = secretValues.get(name)!
      if (await hmacSha256Hex(value, body) === provided) return new Response('', { status: 200 })
    }
    return new Response('', { status: 401 })
  }
  function namedRoute(localRoutes: Routes, profile: keyof typeof GITHUB_FLEET_PROFILES) {
    return localRoutes.subs.find((sub) => sub.name === githubFleetSubscriptionName(SITE_REPO, profile))!
  }
  const readKv = async () => cloneKv(remote)
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
  const pingHook = vi.fn(async () => ({ id: 'ping-guid', event: 'ping', statusCode: 200, deliveredAt: null }))
  const dependencies: GitHubFleetReconcileDependencies = {
    planDependencies: {
      discover: async () => ({ repositories: [], exclusions: [], blockers: [] }),
      listHooks: async () => [...hooks],
      listSecrets: async () => new Set(remoteSecretNames),
      readKv,
      fileSystem,
    },
    listHooks: async () => [...hooks],
    updateHook,
    pingHook,
    listSecrets: async () => new Set(remoteSecretNames),
    deleteSecrets: async (names) => {
      for (const name of names) remoteSecretNames.delete(name)
      return new Set(remoteSecretNames)
    },
    readKv,
    putKv,
    fetch: fetcher,
    sleep: async () => undefined,
    routeTimeoutMs: 10,
    routeIntervalMs: 1,
    mutationRetryMs: 0,
  }
  return {
    directory,
    fileSystem,
    entry,
    remoteSecretNames,
    authTransitions,
    updateHook,
    pingHook,
    dependencies,
  }
}

describe('site HMAC consolidation', () => {
  it('moves both hooks through expanded and contracted auth before retiring secrets', async () => {
    const harness = await siteHarness(true)
    try {
      await expect(consolidateSiteHmacs(
        fleetOptions('apply'),
        harness.directory,
        harness.dependencies,
      )).resolves.toBe(true)
      const routes = parseRoutes(await readFile(join(harness.directory, 'routes.jsonc'), 'utf8'))
      for (const profile of ['stars', 'alerts'] as const) {
        expect(routes.subs.find((sub) => sub.name === githubFleetSubscriptionName(SITE_REPO, profile))?.auth).toEqual({
          scheme: 'github-sha256',
          secretEnv: harness.entry.hmac.name,
        })
      }
      expect(harness.authTransitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ secretEnv: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS', alternates: [harness.entry.hmac.name] }),
        expect.objectContaining({ secretEnv: harness.entry.hmac.name, alternates: ['HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS'] }),
        expect.objectContaining({ secretEnv: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_ALERTS', alternates: [harness.entry.hmac.name] }),
        expect.objectContaining({ secretEnv: harness.entry.hmac.name, alternates: ['HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_ALERTS'] }),
      ]))
      expect(harness.remoteSecretNames).toEqual(new Set([harness.entry.hmac.name]))
      const savedManifest = parseGitHubFleetManifest(await readFile(join(harness.directory, 'fleet.json'), 'utf8'))
      expect(savedManifest.repositories[SITE_REPO]?.retiringHmacs).toBeUndefined()
      const devVars = await readFile(join(harness.directory, '.dev.vars'), 'utf8')
      expect(devVars).not.toContain('SITE_STARS')
      expect(devVars).not.toContain('SITE_ALERTS')
    } finally {
      await rm(harness.directory, { recursive: true, force: true })
    }
  })

  it('resumes safely when retired Wrangler secrets were already deleted', async () => {
    const harness = await siteHarness(false, true)
    try {
      await consolidateSiteHmacs(fleetOptions('apply'), harness.directory, harness.dependencies)
      expect(harness.remoteSecretNames).toEqual(new Set([harness.entry.hmac.name]))
      expect(harness.authTransitions.every((transition) => transition.secretEnv === harness.entry.hmac.name)).toBe(true)
      expect(harness.updateHook).toHaveBeenCalledTimes(2)
    } finally {
      await rm(harness.directory, { recursive: true, force: true })
    }
  })

  it('leaves an expanded safe route after a hook update failure and completes on rerun', async () => {
    const harness = await siteHarness(true)
    try {
      const failing = {
        ...harness.dependencies,
        updateHook: async () => { throw new Error('simulated update failure') },
      }
      await expect(consolidateSiteHmacs(fleetOptions('apply'), harness.directory, failing)).rejects.toThrow(/simulated/)
      const interruptedRoutes = parseRoutes(await readFile(join(harness.directory, 'routes.jsonc'), 'utf8'))
      expect(interruptedRoutes.subs.find((sub) => sub.name === githubFleetSubscriptionName(SITE_REPO, 'stars'))?.auth).toEqual({
        scheme: 'github-sha256',
        secretEnv: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_STARS',
        alternateSecretEnvs: [harness.entry.hmac.name],
      })
      expect((await readFile(join(harness.directory, '.dev.vars'), 'utf8'))).toContain('SITE_STARS')
      expect(parseGitHubFleetManifest(await readFile(join(harness.directory, 'fleet.json'), 'utf8'))
        .repositories[SITE_REPO]?.retiringHmacs).toBeDefined()

      await expect(consolidateSiteHmacs(
        fleetOptions('apply'),
        harness.directory,
        harness.dependencies,
      )).resolves.toBe(true)
    } finally {
      await rm(harness.directory, { recursive: true, force: true })
    }
  })
})
