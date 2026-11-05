import { z } from 'zod'
import { applyEdits, modify } from 'jsonc-parser'
import { canonicalConfiguration } from '../../../src/configuration/authority'
import { HANDOFF_KEYS, HANDOFF_PROFILE_NAMES, handoffHmacName, handoffSubscriptionName, normalizeHandoffRepository } from '../../../src/lib/github-handoff'
import { hashSubscriptionSlug } from '../../../src/lib/subscription'
import { parseRoutes, type Sub } from '../../../scripts/sync'
import { githubFleetManifestProfiles, parseGitHubFleetManifest, PROVIDER_MANIFEST_VERSION, serializeGitHubFleetManifest, type GitHubFleetManifest, type GitHubFleetManifestRepository } from './manifest'

const MAX_PRIVATE_BYTES = 128 * 1024
const formattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })
const envelopeSchema = z.object({ version: z.literal(1), repository: z.string().min(1).max(240), origin: z.url().max(2048),
  record: z.unknown(), routes: z.array(z.unknown()).min(1).max(3), exportedAt: z.iso.datetime(),
}).strict()
export interface HandoffRecoveryEnvelope {
  version: 1
  repository: string
  origin: string
  record: GitHubFleetManifestRepository & { provider: NonNullable<GitHubFleetManifestRepository['provider']> }
  routes: Sub[]
  exportedAt: string
}
export async function parseHandoffRecoveryEnvelope(text: string): Promise<HandoffRecoveryEnvelope> {
  try {
    if (new TextEncoder().encode(text).length > MAX_PRIVATE_BYTES) throw new Error()
    const value = envelopeSchema.parse(JSON.parse(text))
    const identity = normalizeHandoffRepository(value.repository)
    if (identity.repository !== value.repository || new URL(value.origin).origin !== value.origin || !value.origin.startsWith('https://')) throw new Error()
    const manifest = parseGitHubFleetManifest(JSON.stringify({ version: PROVIDER_MANIFEST_VERSION, repositories: { [value.repository]: value.record }, retiredRepositories: {} }))
    const record = manifest.repositories[value.repository]!
    if (!record.provider || record.hmac.name !== handoffHmacName(value.repository)) throw new Error()
    const routes = parseRoutes(JSON.stringify({ subs: value.routes, sinks: [] })).subs
    const profiles = githubFleetManifestProfiles(record)
    if (routes.length !== profiles.length) throw new Error()
    for (const profile of profiles) {
      const binding = record.provider.resources[profile]!
      const matches = routes.filter(route => route.githubHandoff?.profile === profile)
      if (matches.length !== 1) throw new Error()
      const route = matches[0]!
      const metadata = route.githubHandoff!
      if (route.source !== 'github' || route.name.toLowerCase() !== handoffSubscriptionName(value.repository, profile).toLowerCase() ||
        route.slugHash !== await hashSubscriptionSlug(record.slugs[profile]) || metadata.repositoryId !== record.provider.repositoryId ||
        metadata.workspaceId !== record.provider.workspaceId || metadata.authorityId !== record.provider.authorityId || metadata.resourceId !== binding.resourceId ||
        metadata.repository.toLowerCase() !== identity.key || route.setup?.github?.repo.toLowerCase() !== identity.key ||
        route.setup.github.eventProfiles.join(',') !== profile || route.auth?.scheme !== 'github-sha256' || route.auth.derivationId || route.auth.alternateSecretEnvs) throw new Error()
      if (binding.authMode === 'bundle') {
        if (!('credentialId' in route.auth) || route.auth.credentialId !== record.provider.repositoryId || route.auth.secretEnv !== HANDOFF_KEYS) throw new Error()
      } else if (route.auth.secretEnv !== record.hmac.name || 'credentialId' in route.auth) throw new Error()
    }
    return { ...value, record: record as HandoffRecoveryEnvelope['record'], routes }
  } catch { throw new Error('Private handoff recovery input is invalid or inconsistent') }
}
function conflict(): never { throw new Error('Recovery conflict: existing credentials or provider identities differ; use the owning migration workflow') }
function assertExistingRecord(before: GitHubFleetManifestRepository, after: HandoffRecoveryEnvelope['record']) {
  if (before.state !== 'active' || before.retirement || before.slugRotation || canonicalConfiguration(before.hmac) !== canonicalConfiguration(after.hmac) ||
      canonicalConfiguration(before.slugs) !== canonicalConfiguration(after.slugs) || !githubFleetManifestProfiles(before).every(profile => githubFleetManifestProfiles(after).includes(profile))) conflict()
  if (before.provider) {
    const { resources: beforeResources, ...oldIdentity } = before.provider
    const { resources: afterResources, ...newIdentity } = after.provider
    if (canonicalConfiguration(oldIdentity) !== canonicalConfiguration(newIdentity)) conflict()
    for (const profile of HANDOFF_PROFILE_NAMES) if (beforeResources[profile] && canonicalConfiguration(beforeResources[profile]) !== canonicalConfiguration(afterResources[profile])) conflict()
  }
}
function assertExistingRoute(before: Sub, after: Sub) {
  if (before.slugHash !== after.slugHash || canonicalConfiguration(before.auth) !== canonicalConfiguration(after.auth)) conflict()
  if (before.githubHandoff && canonicalConfiguration(before.githubHandoff) !== canonicalConfiguration(after.githubHandoff)) conflict()
}
export async function mergeHandoffRecovery(manifestText: string, routesText: string | undefined, envelope: HandoffRecoveryEnvelope): Promise<{ manifestText: string; routesText?: string }> {
  const manifest = parseGitHubFleetManifest(manifestText)
  const identity = normalizeHandoffRepository(envelope.repository)
  const existingKey = Object.keys(manifest.repositories).find(repo => repo.toLowerCase() === identity.key)
  if (Object.keys(manifest.retiredRepositories).some(repo => repo.toLowerCase() === identity.key)) conflict()
  if (existingKey) assertExistingRecord(manifest.repositories[existingKey]!, envelope.record)
  const merged: GitHubFleetManifest = { ...manifest, version: PROVIDER_MANIFEST_VERSION, repositories: { ...manifest.repositories, [existingKey ?? envelope.repository]: envelope.record } }
  const nextManifest = serializeGitHubFleetManifest(merged)
  if (routesText === undefined) return { manifestText: nextManifest }
  let text = routesText
  let routes = parseRoutes(text)
  if (routes.baseUrl && routes.baseUrl !== envelope.origin) conflict()
  if (!routes.baseUrl) text = applyEdits(text, modify(text, ['baseUrl'], envelope.origin, { formattingOptions }))
  for (const incoming of envelope.routes) {
    const matches = routes.subs.map((sub, index) => ({ sub, index })).filter(({ sub }) => sub.name.toLowerCase() === incoming.name.toLowerCase() || sub.githubHandoff?.resourceId === incoming.githubHandoff!.resourceId)
    if (matches.length > 1) conflict()
    const existing = matches[0]
    if (existing) assertExistingRoute(existing.sub, incoming)
    else if (routes.subs.some(sub => sub.slugHash === incoming.slugHash)) conflict()
    if (incoming.sinks.some(name => !routes.sinks.some(sink => sink.name === name))) throw new Error('Recovery routes require matching local destination declarations')
    text = applyEdits(text, modify(text, ['subs', existing?.index ?? -1], incoming, { formattingOptions }))
    routes = parseRoutes(text)
  }
  return { manifestText: nextManifest, routesText: text.endsWith('\n') ? text : `${text}\n` }
}
