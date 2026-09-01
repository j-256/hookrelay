// @vitest-environment node

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { hashSubscriptionSlug } from '../../src/lib/subscription'
import {
  parseSubscriptionRetirementArgs,
  runSubscriptionRetirement,
  type SubscriptionRetirementDependencies,
  type SubscriptionRetirementOptions,
} from '../../scripts/sub-retire'
import type { GitHubRepositoryHook } from '../../scripts/providers/github/repository-hooks'
import { parseRetirementManifest } from '../../scripts/retirement-manifest'
import {
  readPrivateOptionalText,
  writePrivateText,
  writeText,
} from '../../scripts/setup'
import { computePlan, parseRoutes } from '../../scripts/sync'
import { modeAwareFileSystem } from '../helpers/atomic-file-system'
import type { AtomicFileSystem } from '../../scripts/setup'

const RAW_SLUG = 'abcdefghijklmnopqrstuv'
const SECRET_VALUE = 'private-subscription-hmac'

async function fixture(fileSystem: AtomicFileSystem): Promise<{ directory: string; routesText: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-sub-retire-'))
  const routesText = `${JSON.stringify({
    baseUrl: 'https://hooks.example.com',
    subs: [{
      name: 'github:example/repo',
      source: 'github',
      slugHash: await hashSubscriptionSlug(RAW_SLUG),
      enabled: true,
      sinks: ['delivery'],
      auth: { scheme: 'github-sha256', secretEnv: 'HMAC_EXAMPLE_REPO' },
      setup: { github: { repo: 'example/repo', eventProfiles: ['push'] } },
    }],
    sinks: [{ name: 'delivery', type: 'discord', urlEnv: 'SINK_DELIVERY_URL' }],
  }, null, 2)}\n`
  await writeFile(join(directory, 'routes.jsonc'), routesText)
  await writePrivateText(
    join(directory, '.dev.vars'),
    `HMAC_EXAMPLE_REPO=${SECRET_VALUE}\nSINK_DELIVERY_URL=https://discord.example/hook\n`,
    fileSystem,
  )
  return { directory, routesText }
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

function dependencies(
  directory: string,
  remote: { subs: Record<string, string>; sinks: Record<string, string> },
  hooks: GitHubRepositoryHook[],
  secrets: Set<string>,
  fileSystem: AtomicFileSystem,
  failFinalSync = false,
): {
  dependencies: SubscriptionRetirementDependencies
  deleteHook: ReturnType<typeof vi.fn>
  logs: string[]
  syncRoutes: string[]
} {
  const logs: string[] = []
  const syncRoutes: string[] = []
  let shouldFail = failFinalSync
  const deleteHook = vi.fn(async (_repo: string, id: number) => {
    const index = hooks.findIndex((hook) => hook.id === id)
    if (index >= 0) hooks.splice(index, 1)
  })
  return {
    deleteHook,
    logs,
    syncRoutes,
    dependencies: {
      readText: (path) => readFile(path, 'utf8'),
      readPrivateText: (path) => readPrivateOptionalText(path, fileSystem),
      writeText,
      writePrivateText: (path, text) => writePrivateText(path, text, fileSystem),
      readKv: async () => ({ subs: { ...remote.subs }, sinks: { ...remote.sinks } }),
      runSync: async (apply, routesPath = join(directory, 'routes.jsonc')) => {
        syncRoutes.push(routesPath)
        const text = await readFile(routesPath, 'utf8')
        if (apply && shouldFail && parseRoutes(text).subs.length === 0) {
          shouldFail = false
          throw new Error('simulated KV interruption')
        }
        if (apply) applyPlan(text, remote)
      },
      confirm: async () => true,
      listHooks: async () => [...hooks],
      deleteHook,
      listSecrets: async () => new Set(secrets),
      deleteSecrets: async (names) => {
        for (const name of names) secrets.delete(name)
        return new Set(secrets)
      },
      log: (line) => logs.push(line),
    },
  }
}

function options(finalize = false): SubscriptionRetirementOptions {
  return {
    name: 'github:example/repo',
    manifest: 'retirements.json',
    finalize,
    yes: true,
  }
}

describe('subscription retirement', () => {
  it('requires an explicit private manifest', () => {
    const longOptions = parseSubscriptionRetirementArgs([
      'github:example/repo', '--manifest', '/secure/retirements.json',
      '--routes', '/secure/routes.jsonc', '--dev-vars', '/secure/dev.vars',
      '--expected-slug-hash', 'a'.repeat(64), '--finalize', '-y',
    ])
    expect(longOptions).toEqual({
      name: 'github:example/repo',
      manifest: '/secure/retirements.json',
      routes: '/secure/routes.jsonc',
      devVars: '/secure/dev.vars',
      expectedSlugHash: 'a'.repeat(64),
      finalize: true,
      yes: true,
    })
    expect(parseSubscriptionRetirementArgs([
      'github:example/repo', '-m', '/secure/retirements.json',
      '-r', '/secure/routes.jsonc', '-d', '/secure/dev.vars',
      '-e', 'a'.repeat(64), '--finalize', '-y',
    ])).toEqual(longOptions)
    expect(() => parseSubscriptionRetirementArgs(['github:example/repo'])).toThrow(/manifest/)
    expect(() => parseSubscriptionRetirementArgs([
      'github:example/repo', '--manifest', '/secure/retirements.json',
      '--expected-slug-hash', 'not-a-hash',
    ])).toThrow(/lowercase SHA-256/)
  })

  it('refuses a same-named route with another slug hash before writing', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const harness = dependencies(directory, remote, [], new Set(['HMAC_EXAMPLE_REPO']), fileSystem)
    try {
      await expect(runSubscriptionRetirement({
        ...options(),
        expectedSlugHash: 'f'.repeat(64),
      }, harness.dependencies, directory)).rejects.toThrow(/does not match the expected slug hash/)
      expect(await readFile(join(directory, 'routes.jsonc'), 'utf8')).toBe(routesText)
      await expect(readFile(join(directory, 'retirements.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses explicit operational file paths and forwards the route path to sync', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const routesPath = join(directory, 'authoritative-routes.jsonc')
    const devVarsPath = join(directory, 'private-dev-vars')
    await rename(join(directory, 'routes.jsonc'), routesPath)
    await rename(join(directory, '.dev.vars'), devVarsPath)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const harness = dependencies(directory, remote, [], new Set(['HMAC_EXAMPLE_REPO']), fileSystem)
    try {
      await expect(runSubscriptionRetirement({
        ...options(),
        routes: routesPath,
        devVars: devVarsPath,
        expectedSlugHash: await hashSubscriptionSlug(RAW_SLUG),
      }, harness.dependencies, directory)).resolves.toBe('applied')
      expect(parseRoutes(await readFile(routesPath, 'utf8')).subs[0]?.enabled).toBe(false)
      expect(harness.syncRoutes).toEqual([routesPath, routesPath])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('disables first, then archives and removes only the exact owned resources', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks: GitHubRepositoryHook[] = [
      {
        id: 1,
        active: true,
        events: ['push'],
        config: {
          url: `https://hooks.example.com/hook/github/${RAW_SLUG}`,
          content_type: 'json',
          insecure_ssl: '0',
        },
      },
      {
        id: 2,
        active: true,
        events: ['push'],
        config: { url: 'https://elsewhere.example/hook', content_type: 'json', insecure_ssl: '0' },
      },
    ]
    const secrets = new Set(['HMAC_EXAMPLE_REPO', 'SINK_DELIVERY_URL'])
    const harness = dependencies(directory, remote, hooks, secrets, fileSystem)
    try {
      await expect(runSubscriptionRetirement(options(), harness.dependencies, directory)).resolves.toBe('applied')
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).subs[0]?.enabled).toBe(false)
      expect(JSON.parse(Object.values(remote.subs)[0]!).enabled).toBe(false)
      expect((await fileSystem.lstat(join(directory, 'retirements.json'))).mode & 0o777).toBe(0o600)

      await expect(runSubscriptionRetirement(options(true), harness.dependencies, directory)).resolves.toBe('finalized')
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).subs).toEqual([])
      expect(remote.subs).toEqual({})
      expect(hooks.map((hook) => hook.id)).toEqual([2])
      expect(secrets.has('HMAC_EXAMPLE_REPO')).toBe(false)
      expect(await readFile(join(directory, '.dev.vars'), 'utf8')).not.toContain('HMAC_EXAMPLE_REPO=')
      const manifest = parseRetirementManifest(await readFile(join(directory, 'retirements.json'), 'utf8'))
      expect(manifest.subscriptions['github:example/repo']).toMatchObject({
        secrets: [{ name: 'HMAC_EXAMPLE_REPO', value: SECRET_VALUE }],
        hook: { repo: 'example/repo', id: 1, deleted: true },
        localRemoved: true,
        kvRemoved: true,
        secretsRemoved: true,
      })
      expect(harness.logs.join('\n')).not.toContain(SECRET_VALUE)
      await expect(runSubscriptionRetirement(options(true), harness.dependencies, directory)).resolves.toBe('complete')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes after hook deletion when the following KV deletion is interrupted', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const hooks: GitHubRepositoryHook[] = [{
      id: 7,
      active: true,
      events: ['push'],
      config: {
        url: `https://hooks.example.com/hook/github/${RAW_SLUG}`,
        content_type: 'json',
        insecure_ssl: '0',
      },
    }]
    const secrets = new Set(['HMAC_EXAMPLE_REPO'])
    const harness = dependencies(directory, remote, hooks, secrets, fileSystem, true)
    try {
      await runSubscriptionRetirement(options(), harness.dependencies, directory)
      await expect(runSubscriptionRetirement(options(true), harness.dependencies, directory)).rejects.toThrow(/interruption/)
      expect(harness.deleteHook).toHaveBeenCalledTimes(1)
      expect(hooks).toEqual([])
      await expect(runSubscriptionRetirement(options(true), harness.dependencies, directory)).resolves.toBe('finalized')
      expect(harness.deleteHook).toHaveBeenCalledTimes(1)
      expect(remote.subs).toEqual({})
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains an archived auth secret while another route still references it', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const routes = parseRoutes(routesText)
    routes.subs.push({
      name: 'shared-automation',
      source: 'cloudevents',
      slugHash: 'd'.repeat(64),
      enabled: false,
      sinks: ['delivery'],
      auth: { scheme: 'hookrelay-sha256', secretEnv: 'HMAC_EXAMPLE_REPO' },
    })
    const sharedRoutesText = `${JSON.stringify(routes, null, 2)}\n`
    await writeFile(join(directory, 'routes.jsonc'), sharedRoutesText)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(sharedRoutesText, remote)
    const secrets = new Set(['HMAC_EXAMPLE_REPO'])
    const harness = dependencies(directory, remote, [], secrets, fileSystem)
    try {
      await runSubscriptionRetirement(options(), harness.dependencies, directory)
      await runSubscriptionRetirement(options(true), harness.dependencies, directory)
      expect(secrets.has('HMAC_EXAMPLE_REPO')).toBe(true)
      expect(await readFile(join(directory, '.dev.vars'), 'utf8')).toContain('HMAC_EXAMPLE_REPO=')
      expect(harness.logs).toContain('Retained shared subscription secret HMAC_EXAMPLE_REPO')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
