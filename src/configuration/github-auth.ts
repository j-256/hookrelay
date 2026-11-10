import { z } from 'zod'
import { type ConfigurationQuery } from './authority'
import { GitHubAuthError, GITHUB_APP_LIMITS, githubAuthDescriptorSchema, githubAuthId, type GitHubAuthDescriptor, type GitHubAuthenticationMode, type GitHubAuthFence, type GitHubHookCapability } from '../lib/github-app-contract'

export const GITHUB_AUTH_REGISTRY_LIMITS = Object.freeze({ CANDIDATE_MS: 24 * 60 * 60 * 1000, PENDING_CANDIDATES: 20, DESCRIPTORS: 100 })
export type GitHubAuthSelection = { mode: GitHubAuthenticationMode; descriptorId: string }
export type GitHubWorkerTarget = { accountId: string; workerName: string }
export type GitHubServingDeployment = GitHubWorkerTarget & { versionId: string; singleVersion: boolean }
export type GitHubAuthCandidateInput = { descriptor: GitHubAuthDescriptor; expectedRevision: number; target: GitHubWorkerTarget; now?: number }
export type GitHubAuthCandidate = { id: string; descriptor: GitHubAuthDescriptor; priorRevision: number; target: GitHubWorkerTarget; state: string; versionId: string | null; expiresAt: number; activatedAt: number | null }
export type GitHubAuthActivationInput = { candidateId: string; attestationId: string; verifyDeployment: () => Promise<GitHubServingDeployment>; now?: number }
export type GitHubAuthReceipt = { candidateId: string; descriptorId: string; revision: number; keyRevision: number; state: 'active'; activatedAt: number; versionId: string }
type DescriptorRow = { id: string; revision: number; key_revision: number; metadata_json: string }
type CandidateRow = { id: string; descriptor_id: string; prior_revision: number; metadata_json: string; account_id: string; worker_name: string; state: string; version_id: string | null; expires_at: number; activated_at: number | null }
export async function githubAuthQuery<Row = Record<string, unknown>>(query: ConfigurationQuery, sql: string, params: (string | number | null)[] = []): Promise<Row[]> {
  try { return await query<Row>({ sql, params }) } catch { throw new GitHubAuthError('unavailable') }
}
function conflict(): never { throw new GitHubAuthError('conflict') }
function parseDescriptor(row: DescriptorRow) {
  try {
    const descriptor = githubAuthDescriptorSchema.parse(JSON.parse(row.metadata_json))
    if (descriptor.id !== row.id || descriptor.revision !== row.revision || descriptor.keyRevision !== row.key_revision) throw new Error()
    return descriptor
  } catch { throw new GitHubAuthError('unavailable') }
}
export async function readGitHubAuthDescriptor(query: ConfigurationQuery, selection: GitHubAuthSelection): Promise<GitHubAuthDescriptor> {
  if (!githubAuthId.safeParse(selection.descriptorId).success || !['app', 'token', 'gh'].includes(selection.mode)) throw new GitHubAuthError('validation')
  const [row] = await githubAuthQuery<DescriptorRow>(query, 'SELECT id,revision,key_revision,metadata_json FROM github_auth_descriptors WHERE id=?', [selection.descriptorId])
  if (!row) throw new GitHubAuthError('unavailable')
  const descriptor = parseDescriptor(row)
  if (descriptor.mode !== selection.mode || descriptor.state !== 'active') throw new GitHubAuthError('denied')
  return descriptor
}
function candidate(row: CandidateRow): GitHubAuthCandidate {
  try { return { id: row.id, descriptor: githubAuthDescriptorSchema.parse(JSON.parse(row.metadata_json)), priorRevision: row.prior_revision, target: { accountId: row.account_id, workerName: row.worker_name }, state: row.state, versionId: row.version_id, expiresAt: row.expires_at, activatedAt: row.activated_at } }
  catch { throw new GitHubAuthError('unavailable') }
}
export async function readGitHubAuthCandidate(query: ConfigurationQuery, id: string) {
  if (!z.uuid().safeParse(id).success) conflict()
  const [row] = await githubAuthQuery<CandidateRow>(query, 'SELECT * FROM github_auth_candidates WHERE id=?', [id])
  if (!row) conflict()
  return candidate(row)
}
export async function prepareGitHubAuthCandidate(query: ConfigurationQuery, input: GitHubAuthCandidateInput): Promise<GitHubAuthCandidate> {
  const descriptor = githubAuthDescriptorSchema.parse(input.descriptor)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || descriptor.revision !== input.expectedRevision + 1 || !githubAuthId.safeParse(input.target.accountId).success || !/^[A-Za-z0-9_-]{1,63}$/.test(input.target.workerName)) throw new GitHubAuthError('validation')
  const metadata = JSON.stringify(descriptor)
  if (new TextEncoder().encode(metadata).byteLength > GITHUB_APP_LIMITS.PRIVATE_BYTES) throw new GitHubAuthError('validation')
  const now = input.now ?? Date.now()
  const id = crypto.randomUUID()
  const rows = await githubAuthQuery(query, `INSERT INTO github_auth_candidates(id,descriptor_id,prior_revision,metadata_json,account_id,worker_name,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT revision FROM github_auth_descriptors WHERE id=?),0)=?
      AND (SELECT count(*) FROM github_auth_candidates WHERE state<>'active' AND expires_at>?)<?
      AND (EXISTS(SELECT 1 FROM github_auth_descriptors WHERE id=?) OR (SELECT count(*) FROM github_auth_descriptors)<?) RETURNING id`, [id, descriptor.id, input.expectedRevision, metadata, input.target.accountId, input.target.workerName, now, now + GITHUB_AUTH_REGISTRY_LIMITS.CANDIDATE_MS, descriptor.id, input.expectedRevision, now, GITHUB_AUTH_REGISTRY_LIMITS.PENDING_CANDIDATES, descriptor.id, GITHUB_AUTH_REGISTRY_LIMITS.DESCRIPTORS])
  if (!rows.length) conflict()
  return readGitHubAuthCandidate(query, id)
}
function receipt(value: GitHubAuthCandidate): GitHubAuthReceipt {
  if (value.state !== 'active' || value.activatedAt === null || !value.versionId) conflict()
  return { candidateId: value.id, descriptorId: value.descriptor.id, revision: value.descriptor.revision, keyRevision: value.descriptor.keyRevision, state: 'active', activatedAt: value.activatedAt, versionId: value.versionId }
}
export async function activateGitHubAuthCandidate(query: ConfigurationQuery, input: GitHubAuthActivationInput): Promise<GitHubAuthReceipt> {
  const current = await readGitHubAuthCandidate(query, input.candidateId)
  if (current.state === 'active') return receipt(current)
  const deployment = await input.verifyDeployment()
  const now = input.now ?? Date.now()
  if (!deployment.singleVersion || deployment.accountId !== current.target.accountId || deployment.workerName !== current.target.workerName || !githubAuthId.safeParse(deployment.versionId).success) conflict()
  const rows = await githubAuthQuery(query, `UPDATE github_auth_candidates SET state='active',attestation_id=?,activated_at=?,version_id=?
    WHERE id=? AND state IN ('prepared','staged','deployed','verified') AND expires_at>?
      AND COALESCE((SELECT revision FROM github_auth_descriptors WHERE id=descriptor_id),0)=prior_revision
      AND EXISTS(SELECT 1 FROM github_auth_attestations a WHERE a.id=? AND a.candidate_id=github_auth_candidates.id AND a.account_id=github_auth_candidates.account_id AND a.worker_name=github_auth_candidates.worker_name
        AND a.version_id=? AND a.fingerprint=json_extract(github_auth_candidates.metadata_json,'$.fingerprint') AND a.expires_at>? AND a.verified_at<=? AND a.consumed_at IS NULL)
    RETURNING id`, [input.attestationId, now, deployment.versionId, current.id, now, input.attestationId, deployment.versionId, now, now])
  if (!rows.length) conflict()
  return receipt(await readGitHubAuthCandidate(query, current.id))
}
export type GitHubAuthorityRecord = { generation: number; revision: number | null; keyRevision: number | null; state: 'unknown' | 'allowed' | 'denied'; digest: string | null; observedAt: number | null; validUntil: number | null }
export async function readGitHubAuthAuthority(query: ConfigurationQuery, descriptor: GitHubAuthDescriptor, repositoryId: number, capability: GitHubHookCapability): Promise<GitHubAuthorityRecord> {
  await githubAuthQuery(query, 'INSERT OR IGNORE INTO github_auth_authority(descriptor_id,repository_id,capability,write_id) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM github_auth_descriptors WHERE id=? AND revision=? AND key_revision=?)', [descriptor.id, repositoryId, capability, crypto.randomUUID(), descriptor.id, descriptor.revision, descriptor.keyRevision])
  const [row] = await githubAuthQuery<{ generation: number; revision: number | null; key_revision: number | null; state: GitHubAuthorityRecord['state']; digest: string | null; observed_at: number | null; valid_until: number | null }>(query, 'SELECT * FROM github_auth_authority WHERE descriptor_id=? AND repository_id=? AND capability=?', [descriptor.id, repositoryId, capability])
  if (!row) conflict()
  return { generation: row.generation, revision: row.revision, keyRevision: row.key_revision, state: row.state, digest: row.digest, observedAt: row.observed_at, validUntil: row.valid_until }
}
export async function recordGitHubAuthAuthority(query: ConfigurationQuery, input: { descriptor: GitHubAuthDescriptor; repositoryId: number; capability: GitHubHookCapability; expectedGeneration: number; digest: string; state: 'allowed' | 'denied'; validUntil: number; now?: number }) {
  const now = input.now ?? Date.now()
  if (!/^[a-f0-9]{64}$/.test(input.digest) || input.validUntil <= now || input.validUntil > now + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS) throw new GitHubAuthError('validation')
  const rows = await githubAuthQuery(query, `UPDATE github_auth_authority SET generation=CASE WHEN digest=? AND state=? THEN generation ELSE generation+1 END,revision=?,key_revision=?,state=?,digest=?,observed_at=?,valid_until=?,write_id=?
    WHERE descriptor_id=? AND repository_id=? AND capability=? AND generation=? AND EXISTS(SELECT 1 FROM github_auth_descriptors WHERE id=? AND revision=? AND key_revision=? AND json_extract(metadata_json,'$.state')='active') RETURNING generation`, [input.digest, input.state, input.descriptor.revision, input.descriptor.keyRevision, input.state, input.digest, now, input.validUntil, crypto.randomUUID(), input.descriptor.id, input.repositoryId, input.capability, input.expectedGeneration, input.descriptor.id, input.descriptor.revision, input.descriptor.keyRevision])
  if (!rows.length) conflict()
  const recorded = await readGitHubAuthAuthority(query, input.descriptor, input.repositoryId, input.capability)
  if (recorded.state !== input.state || recorded.digest !== input.digest || recorded.revision !== input.descriptor.revision || recorded.keyRevision !== input.descriptor.keyRevision || recorded.validUntil !== input.validUntil) conflict()
  return recorded
}
export async function invalidateGitHubAuthAuthority(query: ConfigurationQuery, descriptorId: string) {
  await githubAuthQuery(query, "UPDATE github_auth_authority SET generation=generation+1,state='unknown',digest=NULL,observed_at=NULL,valid_until=NULL,write_id=? WHERE descriptor_id=?", [crypto.randomUUID(), descriptorId])
}
export function githubAuthFencePredicate(fence: GitHubAuthFence, now = Date.now()) {
  return { sql: `EXISTS(SELECT 1 FROM github_auth_descriptors d JOIN github_auth_authority a ON a.descriptor_id=d.id WHERE d.id=? AND d.revision=? AND d.key_revision=? AND json_extract(d.metadata_json,'$.state')='active'
    AND EXISTS(SELECT 1 FROM json_each(d.metadata_json,'$.managementWorkspaces') WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(d.metadata_json,'$.repositories') WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.fullName')=?)
    AND EXISTS(SELECT 1 FROM json_each(d.metadata_json,'$.capabilities') WHERE value=?) AND a.repository_id=? AND a.capability=? AND a.generation=? AND a.state='allowed' AND a.revision=d.revision AND a.key_revision=d.key_revision AND a.valid_until>?)`, params: [fence.descriptorId, fence.revision, fence.keyRevision, fence.workspaceId, fence.repositoryId, fence.repositoryFullName, fence.capability, fence.repositoryId, fence.capability, fence.generation, now] }
}
export async function assertGitHubAuthFence(query: ConfigurationQuery, fence: GitHubAuthFence, now = Date.now()): Promise<void> {
  const guard = githubAuthFencePredicate(fence, now)
  if (!(await githubAuthQuery(query, `SELECT 1 WHERE ${guard.sql}`, guard.params)).length) conflict()
}
export async function assertGitHubAuthCooldown(query: ConfigurationQuery, quotaKey: string, now = Date.now()) {
  const [row] = await githubAuthQuery<{ retry_at: number }>(query, 'SELECT retry_at FROM github_auth_cooldowns WHERE quota_key=? AND retry_at>?', [quotaKey, now])
  if (row) throw new GitHubAuthError('rate_limited', row.retry_at)
}
export async function recordGitHubAuthCooldown(query: ConfigurationQuery, quotaKey: string, retryAt: number, now = Date.now()) {
  await githubAuthQuery(query, 'INSERT INTO github_auth_cooldowns(quota_key,retry_at) VALUES (?,?) ON CONFLICT(quota_key) DO UPDATE SET retry_at=max(retry_at,excluded.retry_at)', [quotaKey, Math.min(Math.max(now + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS, retryAt), now + GITHUB_APP_LIMITS.COOLDOWN_MAX_MS)])
}
