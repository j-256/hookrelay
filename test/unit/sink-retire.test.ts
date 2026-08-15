// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  countActiveSinkDeliveries,
  parseSinkRetirementArgs,
  runSinkRetirement,
  type SinkRetirementDependencies,
  type SinkRetirementOptions,
} from '../../scripts/sink-retire'
import { parseRetirementManifest } from '../../scripts/retirement-manifest'
import { readPrivateOptionalText, writePrivateText, writeText } from '../../scripts/setup'
import { computePlan, parseRoutes } from '../../scripts/sync'
import { modeAwareFileSystem } from '../helpers/atomic-file-system'
import type { AtomicFileSystem } from '../../scripts/setup'

const URL_VALUE = 'https://receiver.example/private-hook'
const SIGNING_VALUE = 'private-signing-secret'

async function fixture(
  fileSystem: AtomicFileSystem,
  subscriptions: unknown[] = [],
): Promise<{ directory: string; routesText: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-sink-retire-'))
  const routesText = `${JSON.stringify({
    subs: subscriptions,
    sinks: [{
      name: 'delivery',
      type: 'webhook',
      urlEnv: 'SINK_DELIVERY_URL',
      signingSecretEnv: 'SINK_DELIVERY_SIGNING_SECRET',
    }],
  }, null, 2)}\n`
  await writeFile(join(directory, 'routes.jsonc'), routesText)
  await writeFile(join(directory, 'wrangler.jsonc'), `${JSON.stringify({
    d1_databases: [{ binding: 'EVENTS_DB', database_id: '11111111-2222-3333-4444-555555555555' }],
  })}\n`)
  await writePrivateText(
    join(directory, '.dev.vars'),
    `SINK_DELIVERY_URL=${URL_VALUE}\nSINK_DELIVERY_SIGNING_SECRET=${SIGNING_VALUE}\n`,
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
  secrets: Set<string>,
  countActiveDeliveries: (wranglerText: string, sinkName: string) => Promise<number>,
  fileSystem: AtomicFileSystem,
): { dependencies: SinkRetirementDependencies; logs: string[] } {
  const logs: string[] = []
  return {
    logs,
    dependencies: {
      readText: (path) => readFile(path, 'utf8'),
      readPrivateText: (path) => readPrivateOptionalText(path, fileSystem),
      writeText,
      writePrivateText: (path, text) => writePrivateText(path, text, fileSystem),
      readKv: async () => ({ subs: { ...remote.subs }, sinks: { ...remote.sinks } }),
      runSync: async (apply) => {
        if (apply) applyPlan(await readFile(join(directory, 'routes.jsonc'), 'utf8'), remote)
      },
      confirm: async () => true,
      countActiveDeliveries,
      listSecrets: async () => new Set(secrets),
      deleteSecrets: async (names) => {
        for (const name of names) secrets.delete(name)
        return new Set(secrets)
      },
      log: (line) => logs.push(line),
    },
  }
}

function options(finalize = false): SinkRetirementOptions {
  return { name: 'delivery', manifest: 'retirements.json', finalize, yes: true }
}

describe('sink retirement', () => {
  it('requires an explicit private manifest', () => {
    expect(parseSinkRetirementArgs(['delivery', '--manifest', 'retirements.json', '--finalize'])).toEqual({
      name: 'delivery',
      manifest: 'retirements.json',
      finalize: true,
      yes: false,
    })
    expect(() => parseSinkRetirementArgs(['delivery'])).toThrow(/manifest/)
  })

  it('preserves staged KV, blocks referenced deliveries, then finalizes recoverably', async () => {
    const fileSystem = modeAwareFileSystem()
    const { directory, routesText } = await fixture(fileSystem)
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const secrets = new Set(['SINK_DELIVERY_URL', 'SINK_DELIVERY_SIGNING_SECRET'])
    const count = vi.fn(async () => 1)
    const harness = dependencies(directory, remote, secrets, count, fileSystem)
    try {
      await expect(runSinkRetirement(options(), harness.dependencies, directory)).resolves.toBe('applied')
      const staged = parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8'))
      expect(staged.sinks).toEqual([])
      expect(staged.retiredSinks?.map((sink) => sink.name)).toEqual(['delivery'])
      expect(remote.sinks['sink:delivery']).toBeDefined()
      expect((await fileSystem.lstat(join(directory, 'retirements.json'))).mode & 0o777).toBe(0o600)

      await expect(runSinkRetirement(options(true), harness.dependencies, directory)).rejects.toThrow(/delivery rows/)
      expect(remote.sinks['sink:delivery']).toBeDefined()
      count.mockResolvedValue(0)
      await expect(runSinkRetirement(options(true), harness.dependencies, directory)).resolves.toBe('finalized')
      expect(parseRoutes(await readFile(join(directory, 'routes.jsonc'), 'utf8')).retiredSinks).toEqual([])
      expect(remote.sinks).toEqual({})
      expect(secrets.has('SINK_DELIVERY_URL')).toBe(false)
      expect(secrets.has('SINK_DELIVERY_SIGNING_SECRET')).toBe(false)
      const manifest = parseRetirementManifest(await readFile(join(directory, 'retirements.json'), 'utf8'))
      expect(manifest.sinks.delivery).toMatchObject({
        localRemoved: true,
        kvRemoved: true,
        secretsRemoved: true,
      })
      expect(manifest.sinks.delivery?.secrets).toEqual([
        { name: 'SINK_DELIVERY_SIGNING_SECRET', value: SIGNING_VALUE },
        { name: 'SINK_DELIVERY_URL', value: URL_VALUE },
      ])
      expect(harness.logs.join('\n')).not.toContain(URL_VALUE)
      expect(harness.logs.join('\n')).not.toContain(SIGNING_VALUE)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires disabled subscription retirements to finish before sink finalization', async () => {
    const fileSystem = modeAwareFileSystem()
    const subscription = {
      name: 'disabled',
      source: 'statuspage',
      slugHash: 'a'.repeat(64),
      enabled: false,
      sinks: ['delivery'],
    }
    const { directory, routesText } = await fixture(fileSystem, [subscription])
    const remote = { subs: {} as Record<string, string>, sinks: {} as Record<string, string> }
    applyPlan(routesText, remote)
    const harness = dependencies(directory, remote, new Set(), vi.fn(async () => 0), fileSystem)
    try {
      await runSinkRetirement(options(), harness.dependencies, directory)
      await expect(runSinkRetirement(options(true), harness.dependencies, directory)).rejects.toThrow(/still referenced/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('queries D1 with parameterized sink and status values without exposing the token', async () => {
    let request: RequestInit | undefined
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init
      return Response.json({ success: true, result: [{ success: true, results: [{ count: 3 }] }] })
    })
    const wrangler = JSON.stringify({
      d1_databases: [{ binding: 'EVENTS_DB', database_id: '11111111-2222-3333-4444-555555555555' }],
    })
    await expect(countActiveSinkDeliveries(wrangler, 'delivery', {
      fetch: fetcher as typeof fetch,
      environment: { CLOUDFLARE_ACCOUNT_ID: 'account-id', CLOUDFLARE_API_TOKEN: 'private-token' },
    })).resolves.toBe(3)
    const body = JSON.parse(request?.body as string)
    expect(body.sql).toContain('sink_name = ?')
    expect(body.params).toEqual(['delivery', 'pending', 'queued', 'processing', 'retrying', 'exhausted'])
    expect(request?.headers).toEqual(expect.objectContaining({ authorization: 'Bearer private-token' }))
    expect(request?.body).not.toContain('private-token')
  })
})
