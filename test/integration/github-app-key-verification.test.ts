import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { configurationQuery } from '../../src/configuration/authority'
import {
  prepareGitHubAuthCandidate,
  activateGitHubAuthCandidate,
  readGitHubRuntimePolicy,
} from '../../src/configuration/github-auth'
import {
  createGitHubAppKeyChallenge,
  handleGitHubAppKeyVerification,
  GITHUB_APP_KEY_VERIFICATION_PATH,
} from '../../src/management/github-app-key-verification'
import { githubAppKeyFingerprint } from '../../src/lib/github-app-token'
const query = configurationQuery(env.EVENTS_DB)
let key: string
let fingerprint: string
const target = { accountId: 'synthetic-account', workerName: 'synthetic-worker' }
beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const bytes = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  key = ['-----BEGIN PRIVATE KEY-----', btoa(String.fromCharCode(...bytes)), '-----END PRIVATE KEY-----'].join('\n')
  fingerprint = await githubAppKeyFingerprint(key)
})
beforeEach(async () => {
  await env.EVENTS_DB.exec(
    "DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; UPDATE github_auth_runtime_policy SET mode='legacy',revision=1;",
  )
})
async function setup() {
  const descriptor = {
    id: 'app',
    revision: 1,
    keyRevision: 1,
    mode: 'app' as const,
    appId: 42,
    installationId: 7,
    accountId: 50,
    keySecretName: 'GITHUB_APP_KEY_A',
    fingerprint,
    managementWorkspaces: ['alpha'],
    capabilities: ['repository-hooks-write' as const],
    repositories: [{ id: 101, fullName: 'example/allowed', ownerId: 50, private: true }],
    state: 'active' as const,
  }
  const candidate = await prepareGitHubAuthCandidate(query, { descriptor, expectedRevision: 0, target })
  await env.EVENTS_DB.prepare("UPDATE github_auth_candidates SET state='deployed',version_id='version-a' WHERE id=?")
    .bind(candidate.id)
    .run()
  const runtime = { ...env, CF_VERSION_METADATA: { id: 'version-a', tag: '', timestamp: '' }, GITHUB_APP_KEY_A: key }
  return { candidate, runtime }
}
function request(nonce: string) {
  return new Request('https://hooks.example' + GITHUB_APP_KEY_VERIFICATION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  })
}
it('claims one protected challenge before returning the exact loaded public fingerprint and serving version', async () => {
  const { candidate, runtime } = await setup()
  const challenge = await createGitHubAppKeyChallenge(query, candidate.id, 'version-a')
  expect((await handleGitHubAppKeyVerification(request('x'.repeat(43)), runtime)).status).toBe(404)
  const response = await handleGitHubAppKeyVerification(request(challenge.nonce), runtime)
  expect(response.status).toBe(200)
  const proof = (await response.json()) as { attestationId: string; fingerprint: string; versionId: string }
  expect(proof.fingerprint).toBe(fingerprint)
  expect(proof.versionId).toBe('version-a')
  expect(JSON.stringify(proof)).not.toContain('PRIVATE KEY')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await handleGitHubAppKeyVerification(request(challenge.nonce), runtime)).status).toBe(404)
  expect((await readGitHubRuntimePolicy(query)).mode).toBe('legacy')
  await expect(
    activateGitHubAuthCandidate(query, {
      candidateId: candidate.id,
      attestationId: proof.attestationId,
      verifyDeployment: async () => ({ ...target, versionId: 'version-b', singleVersion: true }),
    }),
  ).rejects.toMatchObject({ code: 'conflict' })
  await activateGitHubAuthCandidate(query, {
    candidateId: candidate.id,
    attestationId: proof.attestationId,
    verifyDeployment: async () => ({ ...target, versionId: 'version-a', singleVersion: true }),
  })
  expect((await readGitHubRuntimePolicy(query)).mode).toBe('registry')
})
it.each(['expired', 'wrong-key', 'missing-key', 'wrong-version'])(
  'denies %s without candidate metadata and without reusable proof',
  async (kind) => {
    const { candidate, runtime } = await setup()
    const challenge = await createGitHubAppKeyChallenge(query, candidate.id, 'version-a')
    if (kind === 'expired') await env.EVENTS_DB.prepare('UPDATE github_auth_challenges SET expires_at=0').run()
    if (kind === 'wrong-key') runtime.GITHUB_APP_KEY_A = key.replace('M', 'N')
    if (kind === 'missing-key') runtime.GITHUB_APP_KEY_A = ''
    if (kind === 'wrong-version') runtime.CF_VERSION_METADATA.id = 'other'
    const response = await handleGitHubAppKeyVerification(request(challenge.nonce), runtime)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('{"error":"unavailable"}')
    expect(await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_auth_attestations').first('n')).toBe(0)
  },
)
it('does not expose verification through GET or create challenges through management commands', async () => {
  const { runtime } = await setup()
  expect(
    (
      await handleGitHubAppKeyVerification(
        new Request('https://hooks.example' + GITHUB_APP_KEY_VERIFICATION_PATH),
        runtime,
      )
    ).status,
  ).toBe(404)
})
it('uses activated provider selection without a second environment deployment and stays closed after disconnect', async () => {
  const { readGitHubAuthStatus } = await import('../../src/management/github-auth')
  const { candidate, runtime } = await setup()
  const challenge = await createGitHubAppKeyChallenge(query, candidate.id, 'version-a')
  const proof = (await (await handleGitHubAppKeyVerification(request(challenge.nonce), runtime)).json()) as {
    attestationId: string
  }
  await activateGitHubAuthCandidate(query, {
    candidateId: candidate.id,
    attestationId: proof.attestationId,
    verifyDeployment: async () => ({ ...target, versionId: 'version-a', singleVersion: true }),
  })
  const principal = {
    id: 'client',
    revision: 1,
    tokenHash: 'b'.repeat(64),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    workspaceIds: ['alpha'],
    capabilities: ['read'] as ['read'],
  }
  const { descriptorId, mode } = await readGitHubAuthStatus(
    { ...runtime, HOOK_SETUP_GITHUB_TOKEN: 'unused-fallback-canary' },
    principal,
    { workspaceId: 'alpha', actorId: 'owner' },
  )
  expect(mode).toBe('app')
  expect(descriptorId).toBe('app')
  await env.EVENTS_DB.prepare(
    "UPDATE github_auth_descriptors SET revision=2,metadata_json=json_set(metadata_json,'$.revision',2,'$.state','disconnected')",
  ).run()
  const status = await readGitHubAuthStatus(
    { ...runtime, HOOK_SETUP_GITHUB_TOKEN: 'unused-fallback-canary' },
    principal,
    { workspaceId: 'alpha', actorId: 'owner' },
  )
  expect(status.mode).toBe('registry')
  expect(status.state).toBe('unavailable')
})
it('does not extend the original challenge deadline while computing a loaded fingerprint', async () => {
  const { vi } = await import('vitest')
  const { candidate, runtime } = await setup()
  const challenge = await createGitHubAppKeyChallenge(query, candidate.id, 'version-a')
  const now = Date.now()
  await env.EVENTS_DB.prepare('UPDATE github_auth_challenges SET expires_at=?')
    .bind(now + 10)
    .run()
  const time = vi
    .spyOn(Date, 'now')
    .mockReturnValueOnce(now)
    .mockReturnValue(now + 11)
  try {
    expect((await handleGitHubAppKeyVerification(request(challenge.nonce), runtime)).status).toBe(404)
    expect(await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM github_auth_attestations').first('n')).toBe(0)
  } finally {
    time.mockRestore()
  }
})
