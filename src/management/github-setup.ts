import { z } from 'zod'
import type { Env } from '../index'
import type { Subscription } from '../types'
import {
  acceptConfigurationChange,
  configurationDigest,
  configurationQuery,
  readConfigurationReceipt,
  readConfigurationState,
  CONFIGURATION_LIMITS,
  ConfigurationError,
  type ConfigurationEntry,
} from '../configuration/authority'
import { readSubscriptionPolicy } from '../configuration/policy'
import {
  deriveGitHubSetupSecret,
  GITHUB_SETUP_KEY,
  githubSetupMetadata,
} from '../lib/github-setup'
import { subscriptionKvKeyForSlug } from '../lib/subscription'
import {
  authorizeManagement,
  authorizeProvision,
  type ManagementPrincipal,
} from './access'
import {
  managementInputs,
  ManagementError,
  type ManagementContext,
} from './contract'

export const GITHUB_SETUP_LIMITS = Object.freeze({
  PAGES: 3,
  PAGE_SIZE: 100,
  RESPONSE_BYTES: 262144,
  TIMEOUT_MS: 8000,
  DELIVERY_EVENTS: 25,
})
type Input = z.infer<typeof managementInputs.github_setup_plan>
type Row = {
  id: string
  client_id: string
  client_revision: number
  workspace_id: string
  actor_id: string
  authority_id: string
  revision: number
  resource_id: string
  action: 'create' | 'install'
  input_hash: string
  configuration_digest: string
  input_json: string
  state: string
  webhook_id: number | null
  error_code: string | null
  created_at: string
  expires_at: string
  attempted_at: string | null
  updated_at: string
}
const hookSchema = z.object({
  id: z.number().int().positive(),
  active: z.boolean(),
  events: z.array(z.string()).max(100),
  config: z.object({
    url: z.string().max(2048),
    content_type: z.string(),
    insecure_ssl: z.union([z.string(), z.number()]),
  }),
})
type Hook = z.infer<typeof hookSchema>
const timestamp = () => new Date().toISOString()
const owner = (principal: ManagementPrincipal, context: ManagementContext) => ({
  clientId: principal.id,
  clientRevision: principal.revision,
  workspaceId: context.workspaceId,
  actorId: context.actorId,
})
const conflict = () =>
  new ConfigurationError(
    'conflict',
    'Setup changed; keep the draft and prepare a fresh review',
  )

function configuration(env: Env) {
  const key = env.HOOK_SETUP_KEY ?? ''
  const token = env.HOOK_SETUP_GITHUB_TOKEN ?? ''
  let origin: URL
  try {
    origin = new URL(env.HOOK_SETUP_ORIGIN ?? '')
  } catch {
    throw new ConfigurationError(
      'unavailable',
      'The provider ingress origin is not configured',
    )
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    key.length < 32 ||
    key.length > 4096 ||
    !token ||
    token.length > 4096 ||
    /[\s\x00-\x1f\x7f]/.test(token)
  ) {
    throw new ConfigurationError(
      'unavailable',
      'Provider setup requires its ingress origin, setup key and GitHub credential',
    )
  }
  return { key, token, origin: origin.origin }
}

export async function readGitHubSetupConfiguration(
  env: Env,
  principal: ManagementPrincipal,
) {
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  let reason:
    | 'ready'
    | 'inactive'
    | 'grant_required'
    | 'provider_setup_required' = 'ready'
  if (state.mode !== 'active') reason = 'inactive'
  else if (!principal.capabilities.includes('provision'))
    reason = 'grant_required'
  else {
    try {
      configuration(env)
    } catch {
      reason = 'provider_setup_required'
    }
  }
  return {
    ...state,
    canCreate: reason === 'ready',
    reason,
    observedAt: timestamp(),
  }
}

async function find(
  env: Env,
  principal: ManagementPrincipal,
  context: ManagementContext,
  id: string,
) {
  const row = await env.EVENTS_DB.prepare(
    'SELECT * FROM github_setup_reviews WHERE id=?',
  )
    .bind(id)
    .first<Row>()
  if (
    row &&
    (row.client_id !== principal.id ||
      row.client_revision !== principal.revision ||
      row.workspace_id !== context.workspaceId ||
      row.actor_id !== context.actorId)
  ) {
    throw new ConfigurationError('not_found', 'Setup review not found')
  }
  return row
}

async function entry(env: Env, resourceId: string) {
  const [value] = await configurationQuery(env.EVENTS_DB)<ConfigurationEntry>({
    sql: "SELECT namespace,entry_key AS key,resource_id AS resourceId,retired,value FROM configuration_entries WHERE resource_id=? AND namespace='SUBS' AND entry_key LIKE 'sub:sha256:%'",
    params: [resourceId],
  })
  if (!value)
    throw new ConfigurationError('not_found', 'Subscription not found')
  return value
}

async function privateDetails(env: Env, resourceId: string) {
  const saved = await entry(env, resourceId)
  const sub = JSON.parse(saved.value) as Subscription
  const metadata = githubSetupMetadata.parse(sub.githubSetup)
  const config = configuration(env)
  if (
    metadata.resourceId !== resourceId ||
    metadata.origin !== config.origin ||
    metadata.keyDigest !== (await configurationDigest(config.key)) ||
    sub.auth?.derivationId !== resourceId ||
    sub.auth.secretEnv !== GITHUB_SETUP_KEY ||
    sub.source !== 'github'
  )
    throw conflict()
  const slug = await deriveGitHubSetupSecret(config.key, resourceId, 'route')
  if (saved.key !== (await subscriptionKvKeyForSlug(slug))) throw conflict()
  return {
    saved,
    sub,
    metadata,
    config,
    url: `${metadata.origin}/hook/github/${slug}`,
  }
}

async function github(
  config: ReturnType<typeof configuration>,
  repository: string,
  signal: AbortSignal,
  page: number,
  body?: unknown,
) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/hooks${body ? '' : `?per_page=${GITHUB_SETUP_LIMITS.PAGE_SIZE}&page=${page}`}`,
    {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        'user-agent': 'Hookrelay',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  )
  if (response.status !== (body ? 201 : 200)) {
    void response.body?.cancel().catch(() => {})
    throw new ManagementError(
      [400, 401, 403, 404, 422, 429].includes(response.status)
        ? 'github_rejected'
        : 'github_unavailable',
      503,
      'GitHub could not confirm the requested hook operation',
    )
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('GitHub metadata unavailable')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > GITHUB_SETUP_LIMITS.RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        throw new Error('GitHub metadata limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
  ) as unknown
}

async function inspectHooks(
  details: Awaited<ReturnType<typeof privateDetails>>,
  signal: AbortSignal,
) {
  const matches: Hook[] = []
  for (let page = 1; page <= GITHUB_SETUP_LIMITS.PAGES; page++) {
    const hooks = z
      .array(hookSchema)
      .max(GITHUB_SETUP_LIMITS.PAGE_SIZE)
      .parse(
        await github(details.config, details.metadata.repository, signal, page),
      )
    matches.push(...hooks.filter((hook) => hook.config.url === details.url))
    if (hooks.length < GITHUB_SETUP_LIMITS.PAGE_SIZE)
      return { matches, complete: true }
  }
  return { matches, complete: false }
}

function installed(hook: Hook, events: string[]) {
  return (
    hook.active &&
    hook.config.content_type === 'json' &&
    String(hook.config.insecure_ssl) === '0' &&
    events.length === hook.events.length &&
    events.every((event) => hook.events.includes(event))
  )
}

async function result(
  env: Env,
  principal: ManagementPrincipal,
  context: ManagementContext,
  row: Row,
) {
  const input = managementInputs.github_setup_plan.parse(
    JSON.parse(row.input_json),
  )
  const query = configurationQuery(env.EVENTS_DB)
  let receipt =
    row.action === 'create'
      ? await readConfigurationReceipt(query, row.id, owner(principal, context))
      : null
  const state = await readConfigurationState(query)
  if (row.action === 'create' && !receipt)
    receipt = await readConfigurationReceipt(
      query,
      row.id,
      owner(principal, context),
    )
  let status = row.state
  if (status === 'ready')
    status = receipt
      ? 'configured'
      : Date.parse(row.expires_at) <= Date.now()
        ? 'expired'
        : state.authorityId !== row.authority_id ||
            state.revision !== row.revision
          ? 'conflict'
          : 'ready'
  return {
    planId: row.id,
    resourceId: row.resource_id,
    name: input.name,
    repository: input.repository,
    events: input.events,
    sinks: input.sinks,
    action: row.action,
    status,
    errorCode: row.error_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    routingConfigured: row.action === 'install' || receipt !== null,
    webhookInstalled: row.state === 'installed',
    webhookId: row.webhook_id,
  }
}

export async function planGitHubSetup(
  env: Env,
  principal: ManagementPrincipal,
  input: Input,
) {
  authorizeProvision(principal, input.workspaceId)
  const query = configurationQuery(env.EVENTS_DB)
  const inputHash = await configurationDigest({
    ...input,
    ...owner(principal, input),
  })
  const previous = await find(env, principal, input, input.planId)
  if (previous) {
    if (previous.input_hash !== inputHash) throw conflict()
    return result(env, principal, input, previous)
  }
  const config = configuration(env)
  const state = await readConfigurationState(query)
  if (
    state.mode !== 'active' ||
    state.authorityId !== input.authorityId ||
    state.revision !== input.revision
  )
    throw conflict()
  const destinations = await query<{ retired: number }>({
    sql: "SELECT retired FROM configuration_entries WHERE namespace='SINKS' AND entry_key IN (SELECT 'sink:' || value FROM json_each(?))",
    params: [JSON.stringify(input.sinks)],
  })
  if (
    destinations.length !== input.sinks.length ||
    destinations.some((value) => value.retired)
  ) {
    throw new ConfigurationError(
      'validation',
      'Select existing active destinations',
    )
  }
  if (input.resourceId) {
    const details = await privateDetails(env, input.resourceId)
    if (
      details.sub.name !== input.name ||
      details.metadata.repository !== input.repository ||
      JSON.stringify(details.metadata.events) !==
        JSON.stringify(input.events) ||
      JSON.stringify(details.sub.sinks) !== JSON.stringify(input.sinks) ||
      !details.sub.enabled
    )
      throw conflict()
    const unresolved = await env.EVENTS_DB.prepare(
      "SELECT id FROM github_setup_reviews WHERE resource_id=? AND state IN ('installing','indeterminate') LIMIT 1",
    )
      .bind(input.resourceId)
      .first()
    if (unresolved)
      throw new ConfigurationError(
        'conflict',
        'Reconcile the existing installation before preparing another attempt',
      )
  } else {
    const duplicate = await env.EVENTS_DB.prepare(
      "SELECT resource_id FROM configuration_entries WHERE namespace='SUBS' AND json_extract(value,'$.name')=? LIMIT 1",
    )
      .bind(input.name)
      .first()
    if (duplicate)
      throw new ConfigurationError(
        'validation',
        'A subscription already uses this name; link it or choose another name',
      )
  }
  const now = timestamp()
  const expires = new Date(
    Math.min(
      Date.now() + CONFIGURATION_LIMITS.REVIEW_TTL_MS,
      Date.parse(principal.expiresAt),
    ),
  ).toISOString()
  await env.EVENTS_DB.prepare(
    `INSERT INTO github_setup_reviews
    (id,client_id,client_revision,workspace_id,actor_id,authority_id,revision,resource_id,action,input_hash,configuration_digest,input_json,created_at,expires_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
      AND (SELECT count(*) FROM github_setup_reviews WHERE client_id=? AND expires_at>? AND state='ready')<?
    ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      input.planId,
      principal.id,
      principal.revision,
      input.workspaceId,
      input.actorId,
      state.authorityId,
      state.revision,
      input.resourceId ?? crypto.randomUUID(),
      input.resourceId ? 'install' : 'create',
      inputHash,
      await configurationDigest(config),
      JSON.stringify(input),
      now,
      expires,
      now,
      state.authorityId,
      state.revision,
      principal.id,
      now,
      CONFIGURATION_LIMITS.PENDING_REVIEWS,
    )
    .run()
  const saved = await find(env, principal, input, input.planId)
  if (!saved || saved.input_hash !== inputHash) throw conflict()
  return result(env, principal, input, saved)
}

export async function applyGitHubSetup(
  env: Env,
  principal: ManagementPrincipal,
  context: ManagementContext & { planId: string },
) {
  authorizeProvision(principal, context.workspaceId)
  const row = await find(env, principal, context, context.planId)
  if (!row) throw new ConfigurationError('not_found', 'Setup review not found')
  if (!['ready', 'configured'].includes(row.state))
    return result(env, principal, context, row)
  if (Date.parse(row.expires_at) <= Date.now())
    throw new ConfigurationError(
      'expired',
      'Setup review expired; review installation again',
    )
  const config = configuration(env)
  if ((await configurationDigest(config)) !== row.configuration_digest)
    throw conflict()
  const input = managementInputs.github_setup_plan.parse(
    JSON.parse(row.input_json),
  )
  const query = configurationQuery(env.EVENTS_DB)
  if (row.action === 'create') {
    const key = await subscriptionKvKeyForSlug(
      await deriveGitHubSetupSecret(config.key, row.resource_id, 'route'),
    )
    const sub: Subscription = {
      name: input.name,
      source: 'github',
      enabled: true,
      sinks: input.sinks,
      auth: {
        scheme: 'github-sha256',
        secretEnv: GITHUB_SETUP_KEY,
        derivationId: row.resource_id,
      },
      githubSetup: {
        resourceId: row.resource_id,
        repository: input.repository,
        events: input.events,
        origin: config.origin,
        keyDigest: await configurationDigest(config.key),
      },
    }
    await acceptConfigurationChange(query, {
      ...owner(principal, context),
      operationId: row.id,
      authorityId: row.authority_id,
      expectedRevision: row.revision,
      kind: 'lifecycle',
      resourceId: row.resource_id,
      expiresAt: row.expires_at,
      puts: [
        {
          namespace: 'SUBS',
          key,
          resourceId: row.resource_id,
          value: JSON.stringify(sub),
        },
      ],
      deletes: [],
    })
    await env.EVENTS_DB.prepare(
      "UPDATE github_setup_reviews SET state='configured',updated_at=? WHERE id=? AND state='ready'",
    )
      .bind(timestamp(), row.id)
      .run()
  }
  const details = await privateDetails(env, row.resource_id)
  const state = await readConfigurationState(query)
  if (
    state.authorityId !== row.authority_id ||
    state.revision !== row.revision + (row.action === 'create' ? 1 : 0) ||
    !details.sub.enabled ||
    JSON.stringify(details.sub.sinks) !== JSON.stringify(input.sinks)
  )
    throw conflict()
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    GITHUB_SETUP_LIMITS.TIMEOUT_MS,
  )
  let claimed = false
  try {
    const existing = await inspectHooks(details, controller.signal)
    if (!existing.complete)
      throw new ManagementError(
        'github_limited',
        503,
        'GitHub hook inventory exceeds the setup read bound',
      )
    if (existing.matches.length) {
      if (
        existing.matches.length !== 1 ||
        !installed(existing.matches[0]!, input.events)
      )
        throw conflict()
      await env.EVENTS_DB.prepare(
        "UPDATE github_setup_reviews SET state='installed',webhook_id=?,updated_at=? WHERE id=? AND state IN ('ready','configured')",
      )
        .bind(existing.matches[0]!.id, timestamp(), row.id)
        .run()
    } else {
      authorizeProvision(principal, context.workspaceId)
      const claim = await env.EVENTS_DB.prepare(
        `UPDATE github_setup_reviews SET state='installing',attempted_at=?,updated_at=?
        WHERE id=? AND state IN ('ready','configured') AND julianday(expires_at)>julianday('now')
          AND EXISTS (SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
          AND NOT EXISTS (SELECT 1 FROM github_setup_reviews AS other WHERE other.resource_id=? AND other.id!=? AND (other.state IN ('installing','indeterminate') OR other.attempted_at>=github_setup_reviews.created_at))
        RETURNING id`,
      )
        .bind(
          timestamp(),
          timestamp(),
          row.id,
          state.authorityId,
          state.revision,
          row.resource_id,
          row.id,
        )
        .first()
      if (!claim)
        return result(
          env,
          principal,
          context,
          (await find(env, principal, context, row.id))!,
        )
      claimed = true
      const hook = hookSchema.parse(
        await github(config, input.repository, controller.signal, 1, {
          name: 'web',
          active: true,
          events: input.events,
          config: {
            url: details.url,
            content_type: 'json',
            insecure_ssl: '0',
            secret: await deriveGitHubSetupSecret(
              config.key,
              row.resource_id,
              'signature',
            ),
          },
        }),
      )
      if (hook.config.url !== details.url || !installed(hook, input.events))
        throw new Error('GitHub metadata differs')
      await env.EVENTS_DB.prepare(
        "UPDATE github_setup_reviews SET state='installed',webhook_id=?,updated_at=? WHERE id=? AND state='installing'",
      )
        .bind(hook.id, timestamp(), row.id)
        .run()
    }
  } catch (error) {
    const code =
      error instanceof ManagementError &&
      ['github_rejected', 'github_unavailable', 'github_limited'].includes(
        error.code,
      )
        ? error.code
        : 'github_unavailable'
    if (claimed)
      await env.EVENTS_DB.prepare(
        "UPDATE github_setup_reviews SET state=?,error_code=?,updated_at=? WHERE id=? AND state='installing'",
      )
        .bind(
          code === 'github_rejected' ? 'rejected' : 'indeterminate',
          code,
          timestamp(),
          row.id,
        )
        .run()
    else
      await env.EVENTS_DB.prepare(
        "UPDATE github_setup_reviews SET error_code=?,updated_at=? WHERE id=? AND state IN ('ready','configured')",
      )
        .bind(code, timestamp(), row.id)
        .run()
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'github.setup.incomplete',
        operationId: row.id,
        resourceId: row.resource_id,
        code,
        attempted: claimed,
        elapsedMs: Date.now() - started,
      }),
    )
  } finally {
    clearTimeout(timer)
  }
  return result(
    env,
    principal,
    context,
    (await find(env, principal, context, row.id))!,
  )
}

export async function readGitHubSetupStatus(env: Env, resourceId: string) {
  const query = configurationQuery(env.EVENTS_DB)
  const before = await readConfigurationState(query)
  const saved = await entry(env, resourceId)
  const policy = readSubscriptionPolicy(saved)
  let webhook:
    | 'installed'
    | 'missing'
    | 'changed'
    | 'unverified'
    | 'unavailable'
    | 'limited' = 'unverified'
  let deliveredAt: string | null = null
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    GITHUB_SETUP_LIMITS.TIMEOUT_MS,
  )
  try {
    const details = await privateDetails(env, resourceId)
    const inspected = await inspectHooks(details, controller.signal)
    webhook = !inspected.complete
      ? 'limited'
      : !inspected.matches.length
        ? 'missing'
        : inspected.matches.length === 1 &&
            installed(inspected.matches[0]!, details.metadata.events)
          ? 'installed'
          : 'changed'
    const deliveries = await env.EVENTS_DB.prepare(
      `WITH recent AS (SELECT id FROM events WHERE sub_slug=? ORDER BY received_at DESC LIMIT ?)
      SELECT MAX(d.delivered_at) AS deliveredAt FROM recent JOIN deliveries d ON d.event_id=recent.id WHERE d.status='delivered' `,
    )
      .bind(
        saved.key.slice('sub:sha256:'.length),
        GITHUB_SETUP_LIMITS.DELIVERY_EVENTS,
      )
      .first<{ deliveredAt: string | null }>()
    deliveredAt = deliveries?.deliveredAt ?? null
  } catch {
    webhook = JSON.parse(saved.value).githubSetup ? 'unavailable' : 'unverified'
  } finally {
    clearTimeout(timer)
  }
  const after = await readConfigurationState(query)
  if (
    before.authorityId !== after.authorityId ||
    before.revision !== after.revision ||
    before.mode !== after.mode
  )
    throw conflict()
  return {
    resourceId,
    name: policy.name,
    routingConfigured: policy.policy.enabled && policy.policy.sinks.length > 0,
    webhook,
    deliveredAt,
    observedAt: timestamp(),
  }
}

export async function getGitHubSetup(
  env: Env,
  principal: ManagementPrincipal,
  context: ManagementContext & { planId: string },
) {
  authorizeManagement(principal, context.workspaceId)
  const row = await find(env, principal, context, context.planId)
  if (!row) throw new ConfigurationError('not_found', 'Setup review not found')
  if (['installing', 'indeterminate'].includes(row.state)) {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      GITHUB_SETUP_LIMITS.TIMEOUT_MS,
    )
    try {
      const details = await privateDetails(env, row.resource_id)
      const input = managementInputs.github_setup_plan.parse(
        JSON.parse(row.input_json),
      )
      if (
        details.metadata.repository !== input.repository ||
        details.sub.name !== input.name ||
        JSON.stringify(details.metadata.events) !== JSON.stringify(input.events)
      )
        throw conflict()
      const inspected = await inspectHooks(details, controller.signal)
      if (
        inspected.complete &&
        inspected.matches.length === 1 &&
        installed(inspected.matches[0]!, details.metadata.events)
      ) {
        await env.EVENTS_DB.prepare(
          "UPDATE github_setup_reviews SET state='installed',webhook_id=?,error_code=NULL,updated_at=? WHERE id=? AND state IN ('installing','indeterminate')",
        )
          .bind(inspected.matches[0]!.id, timestamp(), row.id)
          .run()
      }
    } catch {
      /* An unavailable read cannot resolve an interrupted external write */
    } finally {
      clearTimeout(timer)
    }
  }
  return result(
    env,
    principal,
    context,
    (await find(env, principal, context, row.id))!,
  )
}

export async function pruneGitHubSetupReviews(env: Env) {
  const cutoff = new Date(
    Date.now() - CONFIGURATION_LIMITS.RECEIPT_DAYS * 86400000,
  ).toISOString()
  await env.EVENTS_DB.prepare(
    `DELETE FROM github_setup_reviews WHERE id IN (
    SELECT id FROM github_setup_reviews WHERE expires_at<? AND state IN ('ready','installed','rejected')
      AND NOT EXISTS (SELECT 1 FROM configuration_receipts WHERE id=github_setup_reviews.id AND github_setup_reviews.state='ready')
    ORDER BY expires_at LIMIT ?)`,
  )
    .bind(cutoff, CONFIGURATION_LIMITS.PRUNE_BATCH)
    .run()
}
