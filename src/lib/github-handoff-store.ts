import type { Env } from '../index'
import type { Subscription } from '../types'
import { HANDOFF_KEYS, HandoffUnavailableError, handoffAuthSchema, handoffMetadataSchema, type HandoffProfile } from './github-handoff'
import { openHandoffBundle, type HandoffBinding } from './github-handoff-crypto'
import { hashSubscriptionSlug } from './subscription'
import { readOptionalSecret } from './secret'
import { sha256Hex, timingSafeEqualHex } from './hmac'

export interface HandoffRepositoryRow {
  id: string
  authority_id: string
  workspace_id: string
  repository_key: string
  repository: string
  origin: string
  hmac_name: string
  bundle_revision: number
  encrypted_json: string
  created_at: string
}
export function handoffRowBinding(row: HandoffRepositoryRow): HandoffBinding {
  return { authorityId: row.authority_id, workspaceId: row.workspace_id, repositoryId: row.id, repository: row.repository, revision: row.bundle_revision }
}
export async function openHandoffRepository(env: Env, row: HandoffRepositoryRow) {
  return openHandoffBundle(env, handoffRowBinding(row), JSON.parse(row.encrypted_json))
}
export async function verifyHandoffResources(env: Env, row: HandoffRepositoryRow, resources: {
  resourceId: string; profile: HandoffProfile; authMode: 'environment' | 'bundle'; key: string; value: string
}[]) {
  try {
    const bundle = await openHandoffRepository(env, row)
    for (const resource of resources) {
      const sub = JSON.parse(resource.value) as Subscription
      const metadata = handoffMetadataSchema.parse(sub.githubHandoff)
      if (metadata.repositoryId !== row.id || metadata.workspaceId !== row.workspace_id || metadata.authorityId !== row.authority_id ||
        metadata.resourceId !== resource.resourceId || metadata.profile !== resource.profile || metadata.repository !== row.repository ||
        resource.key !== `sub:sha256:${await hashSubscriptionSlug(bundle.slugs[resource.profile])}` || sub.auth?.scheme !== 'github-sha256') throw new HandoffUnavailableError()
      if (resource.authMode === 'bundle') {
        const auth = handoffAuthSchema.parse(sub.auth)
        if (auth.credentialId !== row.id) throw new HandoffUnavailableError()
      } else {
        const value = readOptionalSecret(env, sub.auth.secretEnv)
        if (sub.auth.secretEnv !== bundle.hmac.name || sub.auth.credentialId || sub.auth.derivationId || sub.auth.alternateSecretEnvs || !value ||
          !timingSafeEqualHex(await sha256Hex(new TextEncoder().encode(value)), await sha256Hex(new TextEncoder().encode(bundle.hmac.value)))) throw new HandoffUnavailableError()
      }
    }
    return bundle
  } catch { throw new HandoffUnavailableError() }
}
export async function readHandoffSigningSecret(env: Env, subscription: Subscription): Promise<string> {
  try {
    const auth = handoffAuthSchema.parse(subscription.auth)
    const metadata = handoffMetadataSchema.parse(subscription.githubHandoff)
    if (auth.secretEnv !== HANDOFF_KEYS || auth.credentialId !== metadata.repositoryId) throw new HandoffUnavailableError()
    const row = await env.EVENTS_DB.prepare(`SELECT r.*,c.entry_key AS entry_key FROM github_handoff_repositories r
      JOIN github_handoff_receivers h ON h.repository_id=r.id
      JOIN configuration_entries c ON c.resource_id=h.resource_id AND c.namespace='SUBS'
      JOIN configuration_authority a ON a.authority_id=r.authority_id AND a.mode='active'
      WHERE r.id=? AND r.workspace_id=? AND r.authority_id=? AND h.resource_id=? AND h.profile=? AND h.auth_mode='bundle'`)
      .bind(auth.credentialId, metadata.workspaceId, metadata.authorityId, metadata.resourceId, metadata.profile)
      .first<HandoffRepositoryRow & { entry_key: string }>()
    if (!row || row.repository !== metadata.repository) throw new HandoffUnavailableError()
    const bundle = await openHandoffRepository(env, row)
    if (row.entry_key !== `sub:sha256:${await hashSubscriptionSlug(bundle.slugs[metadata.profile])}`) throw new HandoffUnavailableError()
    return bundle.hmac.value
  } catch { throw new HandoffUnavailableError() }
}
