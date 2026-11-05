import type { Env } from '../index'
import type { Subscription } from '../types'
import { HANDOFF_KEYS, HandoffUnavailableError, handoffAuthSchema, handoffMetadataSchema } from './github-handoff'
import { openHandoffBundle, type HandoffBinding } from './github-handoff-crypto'
import { hashSubscriptionSlug } from './subscription'

export interface HandoffRepositoryRow {
  id: string
  authority_id: string
  workspace_id: string
  repository_key: string
  repository: string
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
