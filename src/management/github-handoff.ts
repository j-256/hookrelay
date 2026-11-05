import { z } from 'zod'
import type { Env } from '../index'
import type { Subscription } from '../types'
import { acceptConfigurationChange, configurationDigest, configurationEntrySchema, configurationQuery, readConfigurationReceipt, readConfigurationState, CONFIGURATION_LIMITS, ConfigurationError, type ConfigurationEntry } from '../configuration/authority'
import { HANDOFF_KEYS, HANDOFF_PROFILE_NAMES, HandoffUnavailableError, handoffBundleSchema, handoffHmacName, handoffProfileFilter, handoffProfileSchema, handoffSubscriptionName, normalizeHandoffRepository, type HandoffBundle } from '../lib/github-handoff'
import { handoffKeyStatus, sealHandoffBundle } from '../lib/github-handoff-crypto'
import { openHandoffRepository, verifyHandoffResources, type HandoffRepositoryRow } from '../lib/github-handoff-store'
import { readOptionalSecret } from '../lib/secret'
import { sha256Hex, timingSafeEqualHex } from '../lib/hmac'
import { hashSubscriptionSlug } from '../lib/subscription'
import { authorizeHandoff, type ManagementPrincipal } from './access'
import { handoffAdoptionSchema, handoffInputs, handoffPlanSchema, type handoffContext } from './github-handoff-contract'

const LIMITS = Object.freeze({ HMAC_BYTES: 32, SLUG_BYTES: 16, REPOSITORIES: 500, EVENT_SAMPLE: 25 })
type Context = z.infer<typeof handoffContext>
type ReviewRow = {
  id: string; client_id: string; client_revision: number; workspace_id: string; actor_id: string;
  authority_id: string; revision: number; repository_id: string; resource_id: string; action: 'create' | 'adopt';
  input_hash: string; configuration_digest: string; input_json: string; encrypted_input: string | null;
  state: 'ready' | 'configured'; created_at: string; expires_at: string; updated_at: string;
}
const selectionSchema = z.object({
  resourceId: z.uuid(), profile: handoffProfileSchema, authMode: z.enum(['environment', 'bundle']), previous: configurationEntrySchema.optional(),
}).strict()
const storedSchema = z.object({
  repository: z.string(), repositoryKey: z.string(), origin: z.string(),
  profile: handoffProfileSchema, sinks: z.array(z.string()).max(25), resources: z.array(selectionSchema).min(1).max(3),
}).strict()
type Stored = z.infer<typeof storedSchema>
const timestamp = () => new Date().toISOString()
const notFound = () => new ConfigurationError('not_found', 'Manual hook record not found')
const conflict = () => new ConfigurationError('conflict', 'Manual hook setup changed; retain the draft and prepare a new review after reconciling existing work')
function repositoryIdentity(value: string) {
  try { return normalizeHandoffRepository(value) }
  catch { throw new ConfigurationError('validation', 'Use an HTTPS github.com repository page URL or owner/repository') }
}
function owner(principal: ManagementPrincipal, context: Context) {
  return { clientId: principal.id, clientRevision: principal.revision, workspaceId: context.workspaceId, actorId: context.actorId }
}
export function handoffOrigin(env: Env): string {
  try {
    const url = new URL(env.HOOK_SETUP_ORIGIN ?? '')
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.origin
  } catch { throw new HandoffUnavailableError() }
}
async function configurationFingerprint(env: Env) {
  if (!handoffKeyStatus(env)) throw new HandoffUnavailableError()
  return configurationDigest({ origin: handoffOrigin(env), keyring: env.HOOK_HANDOFF_KEYS })
}
export async function readHandoffConfiguration(env: Env, principal: ManagementPrincipal) {
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  let reason = 'ready'
  if (state.mode !== 'active') reason = 'inactive'
  else if (!principal.capabilities.includes('handoff')) reason = 'grant_required'
  else { try { await configurationFingerprint(env) } catch { reason = 'provider_setup_required' } }
  return { ...state, canCreate: reason === 'ready', canReveal: reason === 'ready' && principal.capabilities.includes('custody'), reason, observedAt: timestamp() }
}
async function repositoryByKey(env: Env, authorityId: string, workspaceId: string, repositoryKey: string) {
  const row = await env.EVENTS_DB.prepare('SELECT * FROM github_handoff_repositories WHERE authority_id=? AND repository_key=?')
    .bind(authorityId, repositoryKey).first<HandoffRepositoryRow>()
  if (row && row.workspace_id !== workspaceId) throw notFound()
  return row
}
export async function ownedHandoffRepository(env: Env, workspaceId: string, repositoryId: string) {
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  const row = await env.EVENTS_DB.prepare('SELECT * FROM github_handoff_repositories WHERE id=? AND workspace_id=? AND authority_id=?')
    .bind(repositoryId, workspaceId, state.authorityId).first<HandoffRepositoryRow>()
  if (!row) throw notFound()
  return row
}
async function legacyEntries(env: Env, repository: string) {
  const names = HANDOFF_PROFILE_NAMES.map(profile => handoffSubscriptionName(repository, profile).toLowerCase())
  const entries = await configurationQuery(env.EVENTS_DB)<ConfigurationEntry>({
    sql: "SELECT namespace,entry_key AS key,resource_id AS resourceId,retired,value FROM configuration_entries WHERE namespace='SUBS' AND lower(json_extract(value,'$.name')) IN (SELECT value FROM json_each(?)) LIMIT 4",
    params: [JSON.stringify(names)],
  })
  if (entries.length > HANDOFF_PROFILE_NAMES.length) throw new ConfigurationError('conflict', 'Legacy receiver identities are ambiguous; resolve them before adoption')
  return entries
}
export async function handoffReceivers(env: Env, row: HandoffRepositoryRow) {
  const result = await env.EVENTS_DB.prepare(`SELECT h.resource_id AS resourceId,h.profile,h.auth_mode AS authMode,c.entry_key AS key,c.value
    FROM github_handoff_receivers h JOIN configuration_entries c ON c.resource_id=h.resource_id AND c.namespace='SUBS'
    WHERE h.repository_id=? ORDER BY CASE h.profile WHEN 'activity' THEN 0 WHEN 'stars' THEN 1 ELSE 2 END LIMIT 4`)
    .bind(row.id).all<{ resourceId: string; profile: z.infer<typeof handoffProfileSchema>; authMode: 'environment' | 'bundle'; key: string; value: string }>()
  if (result.results.length > HANDOFF_PROFILE_NAMES.length) throw new HandoffUnavailableError()
  return result.results
}
export async function readHandoffRepository(env: Env, input: unknown) {
  const fields = handoffInputs.github_handoff_repository.parse(input)
  const normalized = repositoryIdentity(fields.repository)
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  const row = await repositoryByKey(env, state.authorityId, fields.workspaceId, normalized.key)
  const resources = row ? (await handoffReceivers(env, row)).map(({ resourceId, profile, authMode }) => ({ resourceId, profile, authMode })) : []
  return { repository: row?.repository ?? normalized.repository, repositoryId: row?.id ?? null, resources,
    adoptionRequired: !row && (await legacyEntries(env, normalized.repository)).length > 0, observedAt: timestamp() }
}
async function findReview(env: Env, principal: ManagementPrincipal, context: Context, id: string) {
  const row = await env.EVENTS_DB.prepare('SELECT * FROM github_handoff_reviews WHERE id=?').bind(id).first<ReviewRow>()
  if (row && (row.client_id !== principal.id || row.client_revision !== principal.revision || row.workspace_id !== context.workspaceId || row.actor_id !== context.actorId)) throw notFound()
  return row
}
async function reviewResult(env: Env, principal: ManagementPrincipal, row: ReviewRow) {
  const saved = storedSchema.parse(JSON.parse(row.input_json))
  const receipt = await readConfigurationReceipt(configurationQuery(env.EVENTS_DB), row.id, owner(principal, { workspaceId: row.workspace_id, actorId: row.actor_id }))
  const current = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  const status = receipt ? 'configured' : Date.parse(row.expires_at) <= Date.now() ? 'expired' :
    current.authorityId !== row.authority_id || current.revision !== row.revision ? 'conflict' : 'ready'
  return { planId: row.id, repositoryId: row.repository_id, resourceId: row.resource_id, repository: saved.repository,
    name: handoffSubscriptionName(saved.repository, saved.profile), profile: saved.profile, profiles: saved.resources.map(resource => resource.profile),
    sinks: saved.sinks, action: row.action, status, routingConfigured: receipt !== null,
    createdAt: row.created_at, expiresAt: row.expires_at, updatedAt: row.updated_at }
}
async function saveReview(env: Env, principal: ManagementPrincipal, fields: { planId: string; authorityId: string; revision: number } & Context,
  action: 'create' | 'adopt', repositoryId: string, saved: Stored, inputHash: string, encryptedInput: string | null) {
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  if (state.mode !== 'active' || state.authorityId !== fields.authorityId || state.revision !== fields.revision) throw conflict()
  const now = timestamp()
  const expires = new Date(Math.min(Date.now() + CONFIGURATION_LIMITS.REVIEW_TTL_MS, Date.parse(principal.expiresAt))).toISOString()
  await env.EVENTS_DB.prepare(`INSERT INTO github_handoff_reviews
    (id,client_id,client_revision,workspace_id,actor_id,authority_id,revision,repository_id,resource_id,action,input_hash,configuration_digest,input_json,encrypted_input,created_at,expires_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
    AND (SELECT count(*) FROM github_handoff_reviews WHERE client_id=? AND expires_at>? AND state='ready')<? ON CONFLICT(id) DO NOTHING`)
    .bind(fields.planId, principal.id, principal.revision, fields.workspaceId, fields.actorId, state.authorityId, state.revision, repositoryId,
      saved.resources[0]!.resourceId, action, inputHash, await configurationFingerprint(env), JSON.stringify(saved), encryptedInput, now, expires, now,
      state.authorityId, state.revision, principal.id, now, CONFIGURATION_LIMITS.PENDING_REVIEWS).run()
  const row = await findReview(env, principal, fields, fields.planId)
  if (!row || row.input_hash !== inputHash) throw conflict()
  return reviewResult(env, principal, row)
}
export async function planHandoff(env: Env, principal: ManagementPrincipal, input: unknown) {
  const fields = handoffPlanSchema.parse(input)
  authorizeHandoff(principal, fields.workspaceId)
  const normalized = repositoryIdentity(fields.repository)
  const inputHash = await configurationDigest({ ...fields, repository: normalized.key, owner: owner(principal, fields) })
  const previous = await findReview(env, principal, fields, fields.planId)
  if (previous) { if (previous.input_hash !== inputHash) throw conflict(); return reviewResult(env, principal, previous) }
  const row = await repositoryByKey(env, fields.authorityId, fields.workspaceId, normalized.key)
  const existingEntries = await legacyEntries(env, normalized.repository)
  if (!row && existingEntries.length) throw new ConfigurationError('conflict', 'Import the existing repository recovery record before adding manual hooks')
  if (row && existingEntries.some(entry => JSON.parse(entry.value).name.toLowerCase() === handoffSubscriptionName(row.repository, fields.profile).toLowerCase())) throw new ConfigurationError('conflict', 'This profile already has a receiver; recover or adopt its existing identity')
  const nameCollision = await env.EVENTS_DB.prepare('SELECT id FROM github_handoff_repositories WHERE authority_id=? AND hmac_name=? AND repository_key!=? LIMIT 1')
    .bind(fields.authorityId, handoffHmacName(normalized.repository), normalized.key).first()
  if (nameCollision) throw new ConfigurationError('conflict', 'This repository conflicts with an existing recovery credential name')
  const destinations = await configurationQuery(env.EVENTS_DB)<{ retired: number }>({ sql: "SELECT retired FROM configuration_entries WHERE namespace='SINKS' AND entry_key IN (SELECT 'sink:' || value FROM json_each(?))", params: [JSON.stringify(fields.sinks)] })
  if (destinations.length !== fields.sinks.length || destinations.some(entry => entry.retired)) throw new ConfigurationError('validation', 'Select existing active destinations')
  const receiver = row ? await env.EVENTS_DB.prepare('SELECT resource_id FROM github_handoff_receivers WHERE repository_id=? AND profile=?').bind(row.id, fields.profile).first<{ resource_id: string }>() : null
  if (receiver && await env.EVENTS_DB.prepare('SELECT resource_id FROM configuration_entries WHERE resource_id=?').bind(receiver.resource_id).first()) throw new ConfigurationError('conflict', 'This profile already has a configured receiver; open its existing record')
  const saved: Stored = { repository: row?.repository ?? normalized.repository, repositoryKey: normalized.key, origin: handoffOrigin(env),
    profile: fields.profile, sinks: fields.sinks, resources: [{ resourceId: receiver?.resource_id ?? crypto.randomUUID(), profile: fields.profile, authMode: 'bundle' }] }
  if (row && row.origin !== saved.origin) throw conflict()
  return saveReview(env, principal, fields, 'create', row?.id ?? crypto.randomUUID(), saved, inputHash, null)
}
async function checkLegacySecret(env: Env, bundle: HandoffBundle, entry: ConfigurationEntry) {
  const sub = JSON.parse(entry.value) as Subscription
  const auth = sub.auth
  const runtime = auth ? readOptionalSecret(env, auth.secretEnv) : undefined
  if (!sub.enabled || entry.retired || sub.source !== 'github' || !auth || auth.scheme !== 'github-sha256' ||
      auth.secretEnv !== bundle.hmac.name || auth.derivationId || auth.credentialId || auth.alternateSecretEnvs || sub.githubSetup || sub.githubHandoff || !runtime ||
      !timingSafeEqualHex(await sha256Hex(new TextEncoder().encode(runtime)), await sha256Hex(new TextEncoder().encode(bundle.hmac.value)))) {
    throw new ConfigurationError('validation', 'The legacy receiver does not match an active ordinary-HMAC recovery record')
  }
}
export async function planHandoffAdoption(env: Env, principal: ManagementPrincipal, input: unknown) {
  const fields = handoffAdoptionSchema.parse(input)
  authorizeHandoff(principal, fields.workspaceId, true)
  const normalized = repositoryIdentity(fields.repository)
  const inputHash = await configurationDigest({ ...fields, repository: normalized.key, owner: owner(principal, fields) })
  const previous = await findReview(env, principal, fields, fields.planId)
  if (previous) { if (previous.input_hash !== inputHash) throw conflict(); return reviewResult(env, principal, previous) }
  const existingRepository = await repositoryByKey(env, fields.authorityId, fields.workspaceId, normalized.key)
  const bundle = handoffBundleSchema.parse({ version: 1, hmac: fields.record.hmac, slugs: fields.record.slugs })
  if (bundle.hmac.name !== handoffHmacName(normalized.repository)) throw new ConfigurationError('validation', 'The repository recovery credential name does not match')
  if (existingRepository && (existingRepository.repository !== normalized.repository || existingRepository.origin !== handoffOrigin(env) ||
    await configurationDigest(await openHandoffRepository(env, existingRepository)) !== await configurationDigest(bundle))) throw conflict()
  const selected = fields.record.profiles ?? [...HANDOFF_PROFILE_NAMES]
  const profiles = HANDOFF_PROFILE_NAMES.filter(profile => selected.includes(profile))
  const entries = await legacyEntries(env, normalized.repository)
  if (entries.length !== profiles.length) throw new ConfigurationError('validation', 'Adoption must include every existing canonical legacy profile')
  if (existingRepository && entries.some(entry => JSON.parse(entry.value).githubHandoff)) throw conflict()
  const resources: Stored['resources'] = []
  for (const profile of profiles) {
    const matches = entries.filter(entry => JSON.parse(entry.value).name.toLowerCase() === handoffSubscriptionName(normalized.repository, profile).toLowerCase())
    if (matches.length !== 1) throw new ConfigurationError('validation', 'Each selected legacy profile must identify one existing receiver')
    const entry = matches[0]!
    if (entry.key !== `sub:sha256:${await hashSubscriptionSlug(bundle.slugs[profile])}`) throw new ConfigurationError('validation', 'The recovery route does not match the existing receiver')
    const reservation = await env.EVENTS_DB.prepare('SELECT repository_id,profile,auth_mode FROM github_handoff_receivers WHERE resource_id=?').bind(entry.resourceId).first<{ repository_id: string; profile: string; auth_mode: string }>()
    if (reservation && (!existingRepository || reservation.repository_id !== existingRepository.id || reservation.profile !== profile || reservation.auth_mode !== 'environment')) throw conflict()
    if (existingRepository && await env.EVENTS_DB.prepare('SELECT resource_id FROM github_handoff_receivers WHERE repository_id=? AND profile=? AND resource_id!=?').bind(existingRepository.id, profile, entry.resourceId).first()) throw conflict()
    await checkLegacySecret(env, bundle, entry)
    resources.push({ resourceId: entry.resourceId, profile, authMode: 'environment', previous: { ...entry, retired: Boolean(entry.retired) } })
  }
  const repositoryId = existingRepository?.id ?? crypto.randomUUID()
  const saved: Stored = { repository: normalized.repository, repositoryKey: normalized.key, origin: handoffOrigin(env),
    profile: profiles[0]!, sinks: (JSON.parse(resources[0]!.previous!.value) as Subscription).sinks, resources }
  const encrypted = existingRepository?.encrypted_json ?? JSON.stringify(await sealHandoffBundle(env, { authorityId: fields.authorityId, workspaceId: fields.workspaceId, repositoryId, repository: saved.repository, revision: 1 }, bundle))
  return saveReview(env, principal, fields, 'adopt', repositoryId, saved, inputHash, encrypted)
}
function randomHex(bytes: number): string { return [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
function randomSlug(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(LIMITS.SLUG_BYTES)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export async function applyHandoff(env: Env, principal: ManagementPrincipal, input: unknown) {
  const context = handoffInputs.github_handoff_apply.parse(input)
  authorizeHandoff(principal, context.workspaceId)
  const row = await findReview(env, principal, context, context.planId)
  if (!row) throw notFound()
  if (row.action === 'adopt') authorizeHandoff(principal, context.workspaceId, true)
  const currentResult = await reviewResult(env, principal, row)
  if (currentResult.routingConfigured) return currentResult
  if (currentResult.status !== 'ready' || await configurationFingerprint(env) !== row.configuration_digest) throw conflict()
  const saved = storedSchema.parse(JSON.parse(row.input_json))
  let repository = await repositoryByKey(env, row.authority_id, row.workspace_id, saved.repositoryKey)
  if (!repository) {
    const bundle: HandoffBundle = { version: 1, hmac: { name: handoffHmacName(saved.repository), value: randomHex(LIMITS.HMAC_BYTES) }, slugs: { activity: randomSlug(), stars: randomSlug(), alerts: randomSlug() } }
    const encrypted = row.encrypted_input ?? JSON.stringify(await sealHandoffBundle(env, { authorityId: row.authority_id, workspaceId: row.workspace_id, repositoryId: row.repository_id, repository: saved.repository, revision: 1 }, bundle))
    await env.EVENTS_DB.prepare(`INSERT INTO github_handoff_repositories(id,authority_id,workspace_id,repository_key,repository,origin,hmac_name,bundle_revision,encrypted_json,created_at)
      SELECT ?,?,?,?,?,?,?,1,?,? WHERE EXISTS (SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
      AND (SELECT count(*) FROM github_handoff_repositories WHERE authority_id=?)<? ON CONFLICT DO NOTHING`)
      .bind(row.repository_id, row.authority_id, row.workspace_id, saved.repositoryKey, saved.repository, saved.origin, handoffHmacName(saved.repository), encrypted, timestamp(), row.authority_id, row.revision, row.authority_id, LIMITS.REPOSITORIES).run()
    repository = await repositoryByKey(env, row.authority_id, row.workspace_id, saved.repositoryKey)
  }
  if (!repository || repository.id !== row.repository_id || repository.origin !== saved.origin) throw conflict()
  const bundle = await openHandoffRepository(env, repository)
  const puts: ConfigurationEntry[] = []
  for (const resource of saved.resources) {
    const metadata = { authorityId: row.authority_id, workspaceId: row.workspace_id, repositoryId: row.repository_id, resourceId: resource.resourceId, repository: saved.repository, profile: resource.profile }
    let value: Subscription
    const key = `sub:sha256:${await hashSubscriptionSlug(bundle.slugs[resource.profile])}`
    if (resource.previous) {
      const [observed] = await configurationQuery(env.EVENTS_DB)<ConfigurationEntry>({ sql: "SELECT namespace,entry_key AS key,resource_id AS resourceId,retired,value FROM configuration_entries WHERE namespace='SUBS' AND resource_id=?", params: [resource.resourceId] })
      if (!observed || await configurationDigest({ ...observed, retired: Boolean(observed.retired) }) !== await configurationDigest(resource.previous)) throw conflict()
      await checkLegacySecret(env, bundle, observed)
      value = { ...JSON.parse(observed.value), githubHandoff: metadata }
    } else {
      const filter = handoffProfileFilter(resource.profile)
      value = { name: handoffSubscriptionName(saved.repository, resource.profile), source: 'github', enabled: true, sinks: saved.sinks,
        auth: { scheme: 'github-sha256', secretEnv: HANDOFF_KEYS, credentialId: row.repository_id }, githubHandoff: metadata, ...(filter ? { filter } : {}) }
    }
    await env.EVENTS_DB.prepare(`INSERT INTO github_handoff_receivers(resource_id,repository_id,profile,auth_mode,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active') ON CONFLICT DO NOTHING`)
      .bind(resource.resourceId, row.repository_id, resource.profile, resource.authMode, timestamp(), row.authority_id, row.revision).run()
    const accepted = await env.EVENTS_DB.prepare('SELECT resource_id,auth_mode FROM github_handoff_receivers WHERE repository_id=? AND profile=?').bind(row.repository_id, resource.profile).first<{ resource_id: string; auth_mode: string }>()
    if (!accepted || accepted.resource_id !== resource.resourceId || accepted.auth_mode !== resource.authMode) throw conflict()
    puts.push({ namespace: 'SUBS', resourceId: resource.resourceId, key, value: JSON.stringify(value), retired: false })
  }
  authorizeHandoff(principal, context.workspaceId, row.action === 'adopt')
  await acceptConfigurationChange(configurationQuery(env.EVENTS_DB), { ...owner(principal, context), operationId: row.id, authorityId: row.authority_id,
    expectedRevision: row.revision, kind: 'lifecycle', resourceId: puts.length === 1 ? puts[0]!.resourceId : null, expiresAt: row.expires_at, puts, deletes: [] })
  await env.EVENTS_DB.prepare("UPDATE github_handoff_reviews SET state='configured',updated_at=? WHERE id=?").bind(timestamp(), row.id).run()
  return reviewResult(env, principal, { ...row, state: 'configured', updated_at: timestamp() })
}
export async function getHandoff(env: Env, principal: ManagementPrincipal, input: unknown) {
  const context = handoffInputs.github_handoff_get.parse(input)
  const row = await findReview(env, principal, context, context.planId)
  if (!row) throw notFound()
  return reviewResult(env, principal, row)
}
export async function ownedHandoffReceiver(env: Env, workspaceId: string, resourceId: string) {
  const row = await env.EVENTS_DB.prepare(`SELECT r.* FROM github_handoff_repositories r JOIN github_handoff_receivers h ON h.repository_id=r.id
    JOIN configuration_authority a ON a.authority_id=r.authority_id WHERE r.workspace_id=? AND h.resource_id=?`)
    .bind(workspaceId, resourceId).first<HandoffRepositoryRow>()
  if (!row) throw notFound()
  const receiver = (await handoffReceivers(env, row)).find(resource => resource.resourceId === resourceId)
  if (!receiver) throw notFound()
  return { repository: row, receiver }
}
export async function readHandoffStatus(env: Env, input: unknown) {
  const context = handoffInputs.github_handoff_status.parse(input)
  const { repository, receiver } = await ownedHandoffReceiver(env, context.workspaceId, context.resourceId)
  const sub = JSON.parse(receiver.value) as Subscription
  const authority = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  const events = await env.EVENTS_DB.prepare("SELECT id,type,received_at FROM events WHERE sub_slug=? ORDER BY received_at DESC LIMIT ?")
    .bind(receiver.key.slice('sub:sha256:'.length), LIMITS.EVENT_SAMPLE).all<{ id: string; type: string; received_at: string }>()
  const delivered = await env.EVENTS_DB.prepare("SELECT max(delivered_at) AS at FROM deliveries WHERE event_id IN (SELECT value FROM json_each(?)) AND status='delivered'")
    .bind(JSON.stringify(events.results.map(event => event.id))).first<{ at: string | null }>()
  let credentialAvailable = false
  try {
    await verifyHandoffResources(env, repository, [receiver])
    credentialAvailable = repository.origin === handoffOrigin(env)
  } catch {}
  return { resourceId: receiver.resourceId, repository: repository.repository, profile: receiver.profile, routingConfigured: authority.mode === 'active' && sub.enabled && sub.sinks.length > 0,
    credentialAvailable, pingAt: events.results.find(event => event.type === 'ping.event')?.received_at ?? null,
    deliveredAt: delivered?.at ?? null, sample: { events: events.results.length, limit: LIMITS.EVENT_SAMPLE, truncated: events.results.length === LIMITS.EVENT_SAMPLE }, observedAt: timestamp() }
}

export async function pruneHandoffHistory(env: Env): Promise<void> {
  const dayMs = 24 * 60 * 60 * 1000
  const cutoff = new Date(Date.now() - CONFIGURATION_LIMITS.RECEIPT_DAYS * dayMs).toISOString()
  await env.EVENTS_DB.prepare('DELETE FROM github_handoff_reviews WHERE id IN (SELECT id FROM github_handoff_reviews WHERE expires_at<? LIMIT ?)')
    .bind(cutoff, CONFIGURATION_LIMITS.PRUNE_BATCH).run()
  await env.EVENTS_DB.prepare('DELETE FROM github_handoff_access WHERE id IN (SELECT id FROM github_handoff_access WHERE created_at<? LIMIT ?)')
    .bind(cutoff, CONFIGURATION_LIMITS.PRUNE_BATCH).run()
}
