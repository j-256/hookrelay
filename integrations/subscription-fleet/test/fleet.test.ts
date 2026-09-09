import { describe, expect, it } from 'vitest'
import type { RemoteKvSnapshot } from '../../../scripts/kv'
import type {
  ProviderConfigurationPlan,
  ProviderConfigurationSnapshot,
} from '../../../scripts/provider-configuration'
import { computePlan, parseRoutes } from '../../../scripts/sync'
import { subscriptionKvKey } from '../../../src/lib/subscription'
import {
  applyManagedSubscriptions,
  formatManagedSubscriptionPlan,
  planManagedSubscriptions,
  prepareManagedSubscriptions,
  verifyManagedSubscriptions,
  type ManagedSubscriptionDependencies,
  type ManagedSubscriptionOptions,
} from '../src/fleet'

const PROJECT_ROOT = '/workspace/hookrelay'
const MANIFEST_PATH = '/secure/subscriptions.json'
const SENDER_CONFIG = '/workspace/cloudflare-fleet/wrangler.jsonc'
const HMAC_VALUE = 'a'.repeat(64)
const RAW_SLUG = 'private_slug_123456789'
const SINK_SECRET = 'SINK_SERVICE_STATUS_URL'

const ROUTES = `{
  // Preserve this deployment comment
  "baseUrl": "https://hooks.example.com",
  "subs": [],
  "sinks": [
    { "name": "discord:service-status", "type": "discord", "urlEnv": "${SINK_SECRET}" }
  ]
}\n`

const MANIFEST = `${JSON.stringify({
  version: 1,
  subscriptions: {
    'cloudflare-fleet': {
      source: 'cloudevents',
      sinks: ['discord:service-status'],
      filter: {
        eventTypes: {
          include: [
            'urn:cloudflare-fleet:endpoint:problem:v1',
            'urn:cloudflare-fleet:endpoint:recovered:v1',
          ],
        },
      },
      sender: {
        kind: 'cloudflare-worker',
        configPath: SENDER_CONFIG,
        urlSecretName: 'FLEET_MONITOR_HOOKRELAY_URL',
        hmacSecretName: 'FLEET_MONITOR_HOOKRELAY_HMAC',
      },
      recovery: {
        hmac: { name: 'HMAC_CLOUDFLARE_FLEET', value: HMAC_VALUE },
        slug: RAW_SLUG,
      },
      state: 'active',
    },
  },
}, null, 2)}\n`

function options(phase: ManagedSubscriptionOptions['phase']): ManagedSubscriptionOptions {
  return {
    phase,
    manifest: MANIFEST_PATH,
    subscriptions: ['cloudflare-fleet'],
    yes: true,
  }
}

interface Harness {
  dependencies: ManagedSubscriptionDependencies
  files: Map<string, string>
  receiverSecrets: Set<string>
  senderSecrets: Set<string>
  remote: RemoteKvSnapshot
  senderInventoryCalls: string[]
  receiverInstalls: Array<Array<{ name: string; value: string }>>
  senderInstalls: Array<Array<{ name: string; value: string }>>
  requests: Request[]
}

function harness(routeText = ROUTES): Harness {
  const files = new Map<string, string>([
    [`${PROJECT_ROOT}/routes.jsonc`, routeText],
    [`${PROJECT_ROOT}/.dev.vars`, `${SINK_SECRET}=local-only-value\n`],
    [MANIFEST_PATH, MANIFEST],
  ])
  const receiverSecrets = new Set([SINK_SECRET])
  const senderSecrets = new Set<string>()
  const remote: RemoteKvSnapshot = { subs: {}, sinks: {} }
  const senderInventoryCalls: string[] = []
  const receiverInstalls: Array<Array<{ name: string; value: string }>> = []
  const senderInstalls: Array<Array<{ name: string; value: string }>> = []
  const requests: Request[] = []
  const dependencies: ManagedSubscriptionDependencies = {
    readText: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`missing test file: ${path}`)
      return value
    },
    readPrivateText: async (path) => files.get(path) ?? '',
    writeText: async (path, text) => {
      files.set(path, text)
    },
    writePrivateText: async (path, text) => {
      files.set(path, text)
    },
    fileIssue: async () => null,
    listReceiverSecrets: async () => new Set(receiverSecrets),
    putReceiverSecrets: async (secrets) => {
      receiverInstalls.push(secrets.map((secret) => ({ ...secret })))
      for (const secret of secrets) receiverSecrets.add(secret.name)
      return new Set(receiverSecrets)
    },
    listSenderSecrets: async (configPath) => {
      senderInventoryCalls.push(configPath)
      return new Set(senderSecrets)
    },
    putSenderSecrets: async (_configPath, secrets) => {
      senderInstalls.push(secrets.map((secret) => ({ ...secret })))
      for (const secret of secrets) senderSecrets.add(secret.name)
      return new Set(senderSecrets)
    },
    readKv: async () => structuredClone(remote),
    putKv: async (binding, key, value) => {
      remote[binding === 'SUBS' ? 'subs' : 'sinks'][key] = value
    },
    applyProviderPlan: async () => {
      throw new Error('the legacy test harness does not accept active provider plans')
    },
    confirm: async () => true,
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
  }
  return {
    dependencies,
    files,
    receiverSecrets,
    senderSecrets,
    remote,
    senderInventoryCalls,
    receiverInstalls,
    senderInstalls,
    requests,
  }
}

function applyActiveProviderPlan(
  provider: ProviderConfigurationSnapshot,
  plan: ProviderConfigurationPlan,
): void {
  if (plan.mode !== 'active') throw new Error('test provider accepts only active plans')
  const change = plan.review?.change
  if (!change) return
  for (const put of change.puts) {
    const index = provider.entries.findIndex(entry => entry.namespace === put.namespace && entry.key === put.key)
    if (index === -1) provider.entries.push({ ...put })
    else provider.entries[index] = { ...put }
    provider[put.namespace === 'SUBS' ? 'subs' : 'sinks'][put.key] = put.value
  }
  provider.state.revision = change.expectedRevision + 1
}

describe('managed subscription fleet', () => {
  it('plans only secret names and hash-only route changes', async () => {
    const state = harness()
    const plan = await planManagedSubscriptions(options('plan'), state.dependencies, PROJECT_ROOT)
    expect(plan).toMatchObject({
      blockers: [],
      routeAdditions: ['cloudflare-fleet'],
      localSecretAdditions: ['HMAC_CLOUDFLARE_FLEET'],
      receiverSecretAdditions: ['HMAC_CLOUDFLARE_FLEET'],
      senderSecretAdditions: [{
        subscription: 'cloudflare-fleet',
        configPath: SENDER_CONFIG,
        names: ['FLEET_MONITOR_HOOKRELAY_URL', 'FLEET_MONITOR_HOOKRELAY_HMAC'],
      }],
      remoteSubscriptionUpdates: 1,
      remoteSinkUpdates: 1,
    })
    const printable = JSON.stringify(plan) + formatManagedSubscriptionPlan(plan)
    expect(printable).not.toContain(RAW_SLUG)
    expect(printable).not.toContain(HMAC_VALUE)
    expect(printable).not.toContain(`/hook/cloudevents/${RAW_SLUG}`)
  })

  it('prepares locally, applies selected production state, and verifies an authenticated filtered event', async () => {
    const state = harness()
    const prepared = await prepareManagedSubscriptions(options('prepare'), state.dependencies, PROJECT_ROOT)
    expect(prepared).toMatchObject({ routeAdditions: 1, routeUpdates: 0, localSecretAdditions: 1 })
    const routesText = state.files.get(`${PROJECT_ROOT}/routes.jsonc`)!
    expect(routesText).toContain('// Preserve this deployment comment')
    expect(routesText).not.toContain(RAW_SLUG)
    expect(parseRoutes(routesText).subs[0]).toMatchObject({
      name: 'cloudflare-fleet',
      source: 'cloudevents',
      auth: { scheme: 'hookrelay-sha256', secretEnv: 'HMAC_CLOUDFLARE_FLEET' },
    })

    const applied = await applyManagedSubscriptions(options('apply'), state.dependencies, PROJECT_ROOT)
    expect(applied).toEqual({
      applied: true,
      receiverSecretsInstalled: 1,
      senderSecretsInstalled: 2,
      subscriptionRoutesWritten: 1,
      sinkRoutesWritten: 1,
    })
    expect(state.receiverInstalls[0]).toEqual([
      { name: 'HMAC_CLOUDFLARE_FLEET', value: HMAC_VALUE },
    ])
    expect(state.senderInstalls[0]).toEqual(expect.arrayContaining([
      { name: 'FLEET_MONITOR_HOOKRELAY_HMAC', value: HMAC_VALUE },
      {
        name: 'FLEET_MONITOR_HOOKRELAY_URL',
        value: `https://hooks.example.com/hook/cloudevents/${RAW_SLUG}`,
      },
    ]))
    expect(Object.keys(state.remote.subs)).toHaveLength(1)
    expect(Object.values(state.remote.subs)[0]).not.toContain(RAW_SLUG)

    const verified = await verifyManagedSubscriptions(options('verify'), state.dependencies, PROJECT_ROOT)
    expect(verified).toEqual({
      subscriptions: ['cloudflare-fleet'],
      verifiedRequests: 1,
      issues: [],
    })
    expect(state.requests).toHaveLength(1)
    const request = state.requests[0]!
    expect(request.url).toBe(`https://hooks.example.com/hook/cloudevents/${RAW_SLUG}`)
    expect(request.headers.get('content-type')).toBe('application/cloudevents+json')
    expect(request.headers.get('x-hookrelay-signature-256')).toMatch(/^sha256=[a-f0-9]{64}$/)
    const verificationBody = await request.json() as { type: string }
    expect(verificationBody.type).toBe('urn:hookrelay:subscription-fleet:verification:v1')
  })

  it('blocks an invalid base URL and does not query an unsafe sender config', async () => {
    const state = harness(ROUTES.replace('https://hooks.example.com', 'http://hooks.example.com'))
    state.dependencies.fileIssue = async (path) => path === SENDER_CONFIG
      ? `${path} must not be a symbolic link`
      : null
    const plan = await planManagedSubscriptions(options('plan'), state.dependencies, PROJECT_ROOT)
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'routes.jsonc baseUrl must be an HTTPS origin',
      `${SENDER_CONFIG} must not be a symbolic link`,
    ]))
    expect(state.senderInventoryCalls).toEqual([])
  })

  it('reports route identity drift without printing recovery values', async () => {
    const preparedState = harness()
    await prepareManagedSubscriptions(options('prepare'), preparedState.dependencies, PROJECT_ROOT)
    const drifted = preparedState.files.get(`${PROJECT_ROOT}/routes.jsonc`)!
      .replace('HMAC_CLOUDFLARE_FLEET', 'HMAC_UNRELATED')
    const state = harness(drifted)
    state.files.set(`${PROJECT_ROOT}/.dev.vars`, `HMAC_CLOUDFLARE_FLEET=${HMAC_VALUE}\n`)
    const plan = await planManagedSubscriptions(options('plan'), state.dependencies, PROJECT_ROOT)
    expect(plan.blockers.join('\n')).toMatch(/authentication references/)
    expect(JSON.stringify(plan)).not.toContain(RAW_SLUG)
    expect(JSON.stringify(plan)).not.toContain(HMAC_VALUE)
  })

  it('blocks production ownership collisions before selected KV writes', async () => {
    const state = harness()
    await prepareManagedSubscriptions(options('prepare'), state.dependencies, PROJECT_ROOT)
    const route = parseRoutes(state.files.get(`${PROJECT_ROOT}/routes.jsonc`)!).subs[0]!
    state.remote.subs[subscriptionKvKey(route.slugHash)] = JSON.stringify({
      name: 'unrelated-route',
      source: 'cloudevents',
      enabled: true,
      sinks: [],
      auth: null,
    })
    state.remote.subs[`sub:sha256:${'b'.repeat(64)}`] = JSON.stringify({
      name: 'another-route',
      source: 'cloudevents',
      enabled: true,
      sinks: [],
      auth: { scheme: 'hookrelay-sha256', secretEnv: 'HMAC_CLOUDFLARE_FLEET' },
    })
    const plan = await planManagedSubscriptions(options('plan'), state.dependencies, PROJECT_ROOT)
    expect(plan.blockers).toEqual(expect.arrayContaining([
      'cloudflare-fleet: production slug hash is owned by another route',
      'cloudflare-fleet: production HMAC reference is used by another route',
    ]))
  })

  it('applies owned fleet fields while preserving active online enabled policy', async () => {
    const state = harness()
    await prepareManagedSubscriptions(options('prepare'), state.dependencies, PROJECT_ROOT)
    const routes = parseRoutes(state.files.get(`${PROJECT_ROOT}/routes.jsonc`)!)
    const desired = computePlan(routes, { subs: {}, sinks: {} })
    const disabledRoutes = { ...routes, subs: routes.subs.map(subscription => ({ ...subscription, enabled: false })) }
    const online = computePlan(disabledRoutes, { subs: {}, sinks: {} }).subPuts[0]!
    online.value = JSON.stringify({
      ...JSON.parse(online.value),
      filter: { eventTypes: { include: ['stale-provider-event'] } },
    })
    const sink = desired.sinkPuts[0]!
    const active: ProviderConfigurationSnapshot = {
      state: { authorityId: 'd'.repeat(32), revision: 8, mode: 'active' },
      entries: [
        {
          namespace: 'SUBS', key: online.key, value: online.value, retired: false,
          resourceId: '00000000-0000-4000-8000-000000000041',
        },
        {
          namespace: 'SINKS', key: sink.key, value: sink.value, retired: false,
          resourceId: '00000000-0000-4000-8000-000000000042',
        },
      ],
      aliases: [],
      subs: { [online.key]: online.value },
      sinks: { [sink.key]: sink.value },
    }
    state.dependencies.readKv = async () => structuredClone(active)
    state.dependencies.applyProviderPlan = async plan => { applyActiveProviderPlan(active, plan) }

    const plan = await planManagedSubscriptions(options('plan'), state.dependencies, PROJECT_ROOT)
    expect(plan.blockers).toEqual([])
    expect(plan.remoteSubscriptionUpdates).toBe(1)
    expect(plan.remoteSinkUpdates).toBe(0)
    await expect(applyManagedSubscriptions(options('apply'), state.dependencies, PROJECT_ROOT)).resolves.toMatchObject({
      subscriptionRoutesWritten: 1,
      sinkRoutesWritten: 0,
    })
    const applied = JSON.parse(active.subs[online.key]!)
    expect(applied.enabled).toBe(false)
    expect(applied.filter).toEqual(routes.subs[0]!.filter)
  })
})
