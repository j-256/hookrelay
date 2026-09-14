import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest'
import worker, { type Env } from '../../src/index'
import {
  acceptConfigurationChange,
  configurationQuery,
  readConfigurationState,
} from '../../src/configuration/authority'
import { managementTokenHash } from '../../src/management/access'
import { deriveGitHubSetupSecret } from '../../src/lib/github-setup'
import { hmacSha256Hex } from '../../src/lib/hmac'
import { recordingQueue, withDeliveryQueue } from '../helpers/queue'

const token = `hkr_${'s'.repeat(43)}`
const key = 'synthetic-setup-root-secret-value-1234567890'
const context = { workspaceId: 'example', actorId: 'owner' }
const query = configurationQuery(env.EVENTS_DB)
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext
let runtime: Env
let capabilities: string[]
let hooks: Record<string, any>[]
let requests: { method: string; body: any }[]
let mode: 'normal' | 'lost' | 'rejected' | 'unavailable' | 'limited' | 'unknown'
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})
beforeEach(async () => {
  await env.EVENTS_DB.exec(
    "DELETE FROM github_setup_reviews; DELETE FROM configuration_policy_reviews; DELETE FROM configuration_entries; DELETE FROM configuration_receipts; DELETE FROM deliveries; DELETE FROM events; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;",
  )
  capabilities = ['read', 'provision']
  hooks = []
  requests = []
  mode = 'normal'
  const credential = {
    id: 'setup-client',
    revision: 1,
    tokenHash: await managementTokenHash(token),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    workspaceIds: ['example'],
    capabilities,
  }
  runtime = new Proxy(withDeliveryQueue(env, recordingQueue().binding), {
    get(target, prop, receiver) {
      if (prop === 'MANAGEMENT_CREDENTIALS')
        return JSON.stringify([{ ...credential, capabilities }])
      if (prop === 'HOOK_SETUP_KEY') return key
      if (prop === 'HOOK_SETUP_GITHUB_TOKEN') return 'synthetic-github-token'
      if (prop === 'HOOK_SETUP_ORIGIN') return 'https://hooks.example'
      return Reflect.get(target, prop, receiver)
    },
  })
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, {
    ...context,
    clientId: 'operator',
    clientRevision: 1,
    authorityId: state.authorityId,
    expectedRevision: 0,
    kind: 'migration',
    operationId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    deletes: [],
    puts: [
      {
        namespace: 'SINKS',
        key: 'sink:phone',
        resourceId: crypto.randomUUID(),
        value: JSON.stringify({ type: 'ntfy', topic: 'synthetic' }),
      },
    ],
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toMatch(
      /^https:\/\/api.github.com\/repos\/owner\/repo\/hooks/,
    )
    expect(init?.redirect).toBe('manual')
    requests.push({
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (init?.method === 'POST') {
      if (mode === 'rejected') return Response.json({}, { status: 403 })
      if (mode === 'unknown') throw new Error('synthetic unknown outcome')
      const body = JSON.parse(String(init.body))
      const hook = { ...body, id: 42, config: { ...body.config } }
      delete hook.config.secret
      hooks.push(hook)
      if (mode === 'lost') throw new Error('synthetic lost response')
      return Response.json(hook, { status: 201 })
    }
    if (mode === 'unavailable') return Response.json({}, { status: 503 })
    if (mode === 'limited')
      return Response.json(
        Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          active: true,
          events: ['push'],
          config: {
            url: 'https://unrelated.example',
            content_type: 'json',
            insecure_ssl: '0',
          },
        })),
      )
    return Response.json(hooks)
  })
})
afterEach(() => vi.restoreAllMocks())
async function call(command: string, fields: Record<string, unknown> = {}) {
  return worker.fetch(
    new Request('https://hooks.example/admin/api/v1', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command, input: { ...context, ...fields } }),
    }),
    runtime,
    ctx,
  )
}
async function result(command: string, fields: Record<string, unknown> = {}) {
  const response = await call(command, fields)
  const value = (await response.json()) as any
  expect(response.status, JSON.stringify(value)).toBe(200)
  expect(JSON.stringify(value)).not.toContain(key)
  expect(JSON.stringify(value)).not.toContain('/hook/github/')
  expect(JSON.stringify(value)).not.toContain('synthetic-github-token')
  return value.result
}
async function plan(fields: Record<string, unknown> = {}) {
  const state = await readConfigurationState(query)
  return result('github_setup_plan', {
    planId: crypto.randomUUID(),
    authorityId: state.authorityId,
    revision: state.revision,
    resourceId: null,
    name: 'repository-hooks',
    repository: 'owner/repo',
    events: ['push'],
    sinks: ['phone'],
    ...fields,
  })
}
it('creates routing, installs one signed GitHub webhook, and keeps delivery verification separate', async () => {
  expect(await result('github_setup_configuration')).toMatchObject({
    canCreate: true,
  })
  const review = await plan()
  expect(requests).toEqual([])
  const applied = await result('github_setup_apply', { planId: review.planId })
  expect(applied).toMatchObject({
    status: 'installed',
    routingConfigured: true,
    webhookInstalled: true,
  })
  expect(await result('github_setup_apply', { planId: review.planId })).toEqual(
    applied,
  )
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
  expect(
    await result('github_setup_status', { resourceId: review.resourceId }),
  ).toMatchObject({
    routingConfigured: true,
    webhook: 'installed',
    deliveredAt: null,
  })
  const payload = new TextEncoder().encode(
    JSON.stringify({ hook_id: 42, repository: { full_name: 'owner/repo' } }),
  )
  const secret = await deriveGitHubSetupSecret(
    key,
    review.resourceId,
    'signature',
  )
  const signature = await hmacSha256Hex(secret, payload)
  const slug = await deriveGitHubSetupSecret(key, review.resourceId, 'route')
  const response = await worker.fetch(
    new Request(`https://hooks.example/hook/github/${slug}`, {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'setup-ping',
        'x-hub-signature-256': `sha256=${signature}`,
      },
    }),
    runtime,
    ctx,
  )
  expect(response.status).toBe(200)
  expect(
    await result('github_setup_status', { resourceId: review.resourceId }),
  ).toMatchObject({ deliveredAt: null })
})
it('reconciles a lost POST response without sending another installation', async () => {
  mode = 'lost'
  const review = await plan()
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({ status: 'indeterminate', routingConfigured: true })
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({ status: 'indeterminate' })
  expect(
    await result('github_setup_get', { planId: review.planId }),
  ).toMatchObject({ status: 'installed' })
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
})
it('preserves partial routing after a rejected installation and allows a fresh installation review', async () => {
  mode = 'rejected'
  const review = await plan()
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({ status: 'rejected', routingConfigured: true })
  mode = 'normal'
  const retry = await plan({ resourceId: review.resourceId })
  expect(
    await result('github_setup_apply', { planId: retry.planId }),
  ).toMatchObject({ status: 'installed', action: 'install' })
  expect(await readConfigurationState(query)).toMatchObject({ revision: 2 })
})
it('rejects wrong actors, revoked grants, expired plans and concurrent stale creates', async () => {
  const first = await plan()
  const second = await plan({ name: 'other' })
  expect(
    (
      await call('github_setup_apply', {
        planId: first.planId,
        actorId: 'other',
      })
    ).status,
  ).toBe(404)
  expect(
    (
      await call('github_setup_get', {
        planId: first.planId,
        workspaceId: 'other',
      })
    ).status,
  ).toBe(404)
  capabilities = ['read', 'configure']
  expect(
    (await call('github_setup_apply', { planId: first.planId })).status,
  ).toBe(403)
  capabilities = ['read', 'provision']
  await result('github_setup_apply', { planId: first.planId })
  expect(
    (await call('github_setup_apply', { planId: second.planId })).status,
  ).toBe(409)
  const expired = await plan({ name: 'expired' })
  await env.EVENTS_DB.prepare(
    'UPDATE github_setup_reviews SET expires_at=? WHERE id=?',
  )
    .bind('2020-01-01T00:00:00.000Z', expired.planId)
    .run()
  expect(
    (await call('github_setup_apply', { planId: expired.planId })).status,
  ).toBe(409)
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
})
it('races duplicate apply calls without duplicating the GitHub webhook', async () => {
  const review = await plan()
  await Promise.all([
    result('github_setup_apply', { planId: review.planId }),
    result('github_setup_apply', { planId: review.planId }),
  ])
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
})
it('reuses configured routing after an unavailable preflight and does not mistake a bounded inventory for absence', async () => {
  const review = await plan()
  mode = 'limited'
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({
    status: 'configured',
    routingConfigured: true,
    errorCode: 'github_limited',
  })
  expect(requests).toHaveLength(3)
  expect(
    await result('github_setup_status', { resourceId: review.resourceId }),
  ).toMatchObject({ webhook: 'limited' })
  mode = 'unavailable'
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({ status: 'configured', errorCode: 'github_unavailable' })
  expect(requests.some((request) => request.method === 'POST')).toBe(false)
  mode = 'normal'
  const retry = await plan({ resourceId: review.resourceId })
  await Promise.all([
    result('github_setup_apply', { planId: review.planId }),
    result('github_setup_apply', { planId: retry.planId }),
  ])
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
})
it('preserves an unknown POST outcome even when a later read finds no webhook', async () => {
  mode = 'unknown'
  const review = await plan()
  expect(
    await result('github_setup_apply', { planId: review.planId }),
  ).toMatchObject({ status: 'indeterminate' })
  mode = 'normal'
  expect(
    await result('github_setup_get', { planId: review.planId }),
  ).toMatchObject({ status: 'indeterminate' })
  const state = await readConfigurationState(query)
  expect(
    (
      await call('github_setup_plan', {
        planId: crypto.randomUUID(),
        authorityId: state.authorityId,
        revision: state.revision,
        resourceId: review.resourceId,
        name: 'repository-hooks',
        repository: 'owner/repo',
        events: ['push'],
        sinks: ['phone'],
      })
    ).status,
  ).toBe(409)
  await result('github_setup_apply', { planId: review.planId })
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(
    1,
  )
})
it('does not return fresh verification after the provider configuration changes during its read', async () => {
  const review = await plan()
  await result('github_setup_apply', { planId: review.planId })
  vi.mocked(fetch).mockImplementationOnce(async () => {
    await env.EVENTS_DB.prepare(
      'UPDATE configuration_authority SET revision=revision+1',
    ).run()
    return Response.json(hooks)
  })
  expect(
    (await call('github_setup_status', { resourceId: review.resourceId }))
      .status,
  ).toBe(409)
})
it('separates route and signature secrets by resource and rejects repository dot segments', async () => {
  const first = crypto.randomUUID()
  const second = crypto.randomUUID()
  const signature = await deriveGitHubSetupSecret(key, first, 'signature')
  expect(signature).not.toBe(await deriveGitHubSetupSecret(key, first, 'route'))
  expect(signature).not.toBe(
    await deriveGitHubSetupSecret(key, second, 'signature'),
  )
  const state = await readConfigurationState(query)
  for (const repository of [
    'owner/.',
    'owner/..',
    'owner/repo?path',
    'owner/repo/extra',
  ]) {
    expect(
      (
        await call('github_setup_plan', {
          planId: crypto.randomUUID(),
          authorityId: state.authorityId,
          revision: state.revision,
          resourceId: null,
          name: 'repository-hooks',
          repository,
          events: ['push'],
          sinks: ['phone'],
        })
      ).status,
    ).toBe(400)
  }
  expect(requests).toEqual([])
})
