import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { configurationQuery } from '../../src/configuration/authority'
import { activateGitHubAuthCandidate, prepareGitHubAuthCandidate, readGitHubAuthDescriptor, invalidateGitHubAuthAuthority, recordGitHubAuthAuthority, readGitHubAuthAuthority } from '../../src/configuration/github-auth'
import { readGitHubAuthStatus } from '../../src/management/github-auth'
import { managementInputs } from '../../src/management/contract'
import type { GitHubAuthDescriptor } from '../../src/lib/github-app-contract'
const query = configurationQuery(env.EVENTS_DB)
const descriptor: GitHubAuthDescriptor = { id: 'provider-app', revision: 1, mode: 'app', appId: 42, installationId: 7, accountId: 50, keyRevision: 1, keySecretName: 'GITHUB_APP_KEY_A', fingerprint: 'a'.repeat(64), repositories: [{ id: 101, fullName: 'example/allowed', ownerId: 50, private: true }], managementWorkspaces: ['alpha'], capabilities: ['repository-hooks-write'], state: 'active' }
const principal = { id: 'client', revision: 1, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString(), workspaceIds: ['alpha'], capabilities: ['read'] as ['read'] }
const target = { accountId: 'synthetic-account', workerName: 'synthetic-worker' }
beforeAll(() => applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!))
beforeEach(async () => { await env.EVENTS_DB.exec('DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns;') })
async function active() { await env.EVENTS_DB.prepare('INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)').bind(descriptor.id, JSON.stringify(descriptor), crypto.randomUUID()).run() }
it.each(['legacy', 'active'])('reads the same provider registry under %s routing', async mode => {
  await active()
  await env.EVENTS_DB.prepare('UPDATE configuration_authority SET mode=?').bind(mode).run()
  expect(await readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).toEqual(descriptor)
})
it('keeps the prior descriptor active while a new candidate is prepared and refuses unverified activation', async () => {
  await active()
  const candidate = await prepareGitHubAuthCandidate(query, { descriptor: { ...descriptor, revision: 2, keyRevision: 2, fingerprint: 'c'.repeat(64) }, expectedRevision: 1, target })
  expect((await readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).revision).toBe(1)
  await expect(activateGitHubAuthCandidate(query, { candidateId: candidate.id, attestationId: crypto.randomUUID(), verifyDeployment: async () => ({ ...target, versionId: 'version-b', singleVersion: true }) })).rejects.toMatchObject({ code: 'conflict' })
  expect((await readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).revision).toBe(1)
})
it('does not interpret failed or missing registry reads as an implicit token or gh selection', async () => {
  await expect(readGitHubAuthDescriptor(async () => { throw new Error('private-error') }, { mode: 'app', descriptorId: descriptor.id })).rejects.toMatchObject({ code: 'unavailable' })
  await expect(readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).rejects.toMatchObject({ code: 'unavailable' })
  expect(Object.keys(managementInputs)).not.toContain('github_auth_activate')
})
it('limits opt-in management diagnostics to selected workspace authority', async () => {
  await active()
  const runtime = { ...env, GITHUB_AUTH_MODE: 'app', GITHUB_AUTH_DESCRIPTOR: descriptor.id }
  const status = await readGitHubAuthStatus(runtime, principal, { workspaceId: 'alpha', actorId: 'owner' })
  expect(status.repositoryNames).toEqual(['example/allowed'])
  expect(JSON.stringify(status)).not.toContain('GITHUB_APP_KEY_A')
  await expect(readGitHubAuthStatus(runtime, principal, { workspaceId: 'beta', actorId: 'owner' })).rejects.toMatchObject({ status: 404 })
  await env.EVENTS_DB.prepare('UPDATE github_auth_descriptors SET metadata_json=?').bind(JSON.stringify({ ...descriptor, managementWorkspaces: ['beta'], repositories: [{ ...descriptor.repositories[0]!, fullName: 'other/private' }] })).run()
  await expect(readGitHubAuthStatus(runtime, principal, { workspaceId: 'alpha', actorId: 'owner' })).rejects.toThrow()
})
it('cannot overwrite an invalidated authority generation with an old completion', async () => {
  await active()
  const initial = await readGitHubAuthAuthority(query, descriptor, 101, 'repository-hooks-write')
  const accepted = await recordGitHubAuthAuthority(query, { descriptor, repositoryId: 101, capability: 'repository-hooks-write', expectedGeneration: initial.generation, digest: 'd'.repeat(64), state: 'allowed', validUntil: Date.now() + 60000 })
  await invalidateGitHubAuthAuthority(query, descriptor.id)
  await expect(recordGitHubAuthAuthority(query, { descriptor, repositoryId: 101, capability: 'repository-hooks-write', expectedGeneration: accepted.generation, digest: 'd'.repeat(64), state: 'allowed', validUntil: Date.now() + 60000 })).rejects.toMatchObject({ code: 'conflict' })
  expect((await readGitHubAuthAuthority(query, descriptor, 101, 'repository-hooks-write')).state).toBe('unknown')
})
it('rejects a stale candidate and an attestation for a changed or split serving deployment', async () => {
  await active()
  await expect(prepareGitHubAuthCandidate(query, { descriptor: { ...descriptor, revision: 3 }, expectedRevision: 2, target })).rejects.toMatchObject({ code: 'conflict' })
  const candidate = await prepareGitHubAuthCandidate(query, { descriptor: { ...descriptor, revision: 2 }, expectedRevision: 1, target })
  const id = crypto.randomUUID()
  const now = Date.now()
  await env.EVENTS_DB.prepare('INSERT INTO github_auth_attestations(id,candidate_id,account_id,worker_name,version_id,fingerprint,verified_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, candidate.id, target.accountId, target.workerName, 'version-a', descriptor.fingerprint, now, now + 60000).run()
  await expect(activateGitHubAuthCandidate(query, { candidateId: candidate.id, attestationId: id, verifyDeployment: async () => ({ ...target, versionId: 'version-a', singleVersion: false }) })).rejects.toMatchObject({ code: 'conflict' })
  const receipt = await activateGitHubAuthCandidate(query, { candidateId: candidate.id, attestationId: id, verifyDeployment: async () => ({ ...target, versionId: 'version-a', singleVersion: true }) })
  expect(receipt.revision).toBe(2)
  expect((await readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).revision).toBe(2)
  expect(await activateGitHubAuthCandidate(query, { candidateId: candidate.id, attestationId: id, verifyDeployment: async () => { throw new Error('must not replay') } })).toEqual(receipt)
})
it('rechecks attestation expiry after the serving-deployment read completes', async () => {
  await active()
  const candidate = await prepareGitHubAuthCandidate(query, { descriptor: { ...descriptor, revision: 2 }, expectedRevision: 1, target })
  const id = crypto.randomUUID()
  const now = Date.now()
  await env.EVENTS_DB.prepare('INSERT INTO github_auth_attestations(id,candidate_id,account_id,worker_name,version_id,fingerprint,verified_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, candidate.id, target.accountId, target.workerName, 'version-a', descriptor.fingerprint, now, now + 100).run()
  await expect(activateGitHubAuthCandidate(query, { candidateId: candidate.id, attestationId: id, verifyDeployment: async () => { await new Promise(resolve => setTimeout(resolve, 120)); return { ...target, versionId: 'version-a', singleVersion: true } } })).rejects.toMatchObject({ code: 'conflict' })
  expect((await readGitHubAuthDescriptor(query, { mode: 'app', descriptorId: descriptor.id })).revision).toBe(1)
})
