import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { configurationQuery, type ConfigurationQuery, type ConfigurationStatement } from '../../src/configuration/authority'
import {
  githubTokenFingerprint,
  resolveGitHubAuth,
  type GitHubAuthDiagnostic,
  type GitHubAuthResolveInput,
} from '../../src/lib/github-auth'
import type { GitHubAuthDescriptor } from '../../src/lib/github-app-contract'
import { GITHUB_APP_LIMITS } from '../../src/lib/github-app-contract'
import { githubAppKeyFingerprint } from '../../src/lib/github-app-token'
import { invalidateGitHubAuthAuthority } from '../../src/configuration/github-auth'

const query = configurationQuery(env.EVENTS_DB)
const NOW = Date.parse('2026-11-10T12:00:00Z')
const TOKEN = 'synthetic-resolution-manual-token'
const REPOSITORY = { id: 101, fullName: 'owner/repo', ownerId: 50, private: true }
let privateKey: string
let fingerprint: string

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']) as CryptoKeyPair
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
  privateKey = ['-----BEGIN PRIVATE KEY-----', btoa(String.fromCharCode(...bytes)), '-----END PRIVATE KEY-----'].join('\n')
  fingerprint = await githubAppKeyFingerprint(privateKey)
})
beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns;')
})
async function saveDescriptor(descriptor: GitHubAuthDescriptor) {
  await env.EVENTS_DB.prepare(
    'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,?,?,?,?)',
  ).bind(descriptor.id, descriptor.revision, descriptor.keyRevision, JSON.stringify(descriptor), crypto.randomUUID()).run()
}
function interceptQuery(before: (statement: ConfigurationStatement) => Promise<void>): ConfigurationQuery {
  return async <Row>(statement: ConfigurationStatement) => {
    await before(statement)
    return query<Row>(statement)
  }
}
async function manualFixture(response: () => Response) {
  const descriptor: GitHubAuthDescriptor = {
    id: 'manual-auth', revision: 1, keyRevision: 1, mode: 'token',
    tokenSecretName: 'GITHUB_MANUAL_A', fingerprint: await githubTokenFingerprint(TOKEN),
    repositories: [REPOSITORY], managementWorkspaces: ['alpha'],
    capabilities: ['repository-hooks-read'], state: 'active',
  }
  await saveDescriptor(descriptor)
  const diagnostics: GitHubAuthDiagnostic[] = []
  const fetcher = vi.fn(async () => response())
  const input: GitHubAuthResolveInput = {
    query, selection: { mode: 'token', descriptorId: descriptor.id },
    workspaceId: 'alpha', callerId: 'caller', repositoryFullName: REPOSITORY.fullName,
    capability: 'repository-hooks-read', phase: 'read', now: () => NOW,
    loadToken: async () => TOKEN, fetch: fetcher,
    diagnostic: event => diagnostics.push(event),
  }
  return { descriptor, input, diagnostics, fetcher }
}

it.each<{ name: string; status: number; headers: Record<string, string> }>([
  { name: '429 with Retry-After', status: 429, headers: { 'retry-after': '3600' } },
  { name: '403 with Retry-After', status: 403, headers: { 'retry-after': '3600' } },
  { name: '403 with exhausted primary quota', status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 3600) } },
])('reports the first manual-token throttle and shares its deadline: $name', async ({ status, headers }) => {
  const f = await manualFixture(() => Response.json({}, { status, headers }))
  const retryAt = NOW + 3600000
  await expect(resolveGitHubAuth(f.input)).rejects.toMatchObject({ code: 'rate_limited', retryAt })
  expect(f.diagnostics[0]).toMatchObject({ outcome: 'rate_limited', retryAt, providerRequests: 1 })
  const rows = await query<{ retry_at: number }>({ sql: 'SELECT retry_at FROM github_auth_cooldowns', params: [] })
  expect(rows).toEqual([{ retry_at: retryAt }])

  await saveDescriptor({ ...f.descriptor, id: 'other-auth', managementWorkspaces: ['beta'] })
  await expect(resolveGitHubAuth({
    ...f.input, selection: { mode: 'token', descriptorId: 'other-auth' },
    workspaceId: 'beta', callerId: 'other-caller',
  })).rejects.toMatchObject({ code: 'rate_limited', retryAt })
  expect(f.fetcher).toHaveBeenCalledTimes(1)
  expect(f.diagnostics[1]).toMatchObject({ outcome: 'rate_limited', retryAt, providerRequests: 0 })
  expect(JSON.stringify(f.diagnostics)).not.toContain(TOKEN)
})

it('keeps an ordinary manual-token permission refusal distinct from throttling', async () => {
  const f = await manualFixture(() => Response.json({}, { status: 403 }))
  await expect(resolveGitHubAuth(f.input)).rejects.toMatchObject({ code: 'denied', retryAt: null })
  expect(f.diagnostics[0]).toMatchObject({ outcome: 'denied', retryAt: null })
  expect(await query({ sql: 'SELECT retry_at FROM github_auth_cooldowns', params: [] })).toEqual([])
})

it.each<Record<string, string>>([{}, { 'retry-after': '1' }])('reports the persisted minimum cooldown when the clock advances: %j', async headers => {
  const f = await manualFixture(() => Response.json({}, { status: 429, headers }))
  let tick = NOW
  const error = await resolveGitHubAuth({ ...f.input, now: () => tick++ }).catch(error => error)
  const rows = await query<{ retry_at: number }>({ sql: 'SELECT retry_at FROM github_auth_cooldowns', params: [] })
  expect(error).toMatchObject({ code: 'rate_limited', retryAt: rows[0]!.retry_at })
  expect(f.diagnostics[0]).toMatchObject({ outcome: 'rate_limited', retryAt: rows[0]!.retry_at })
})

it('reports a longer cooldown recorded by a concurrent verifier', async () => {
  const f = await manualFixture(() => Response.json({}, { status: 429 }))
  let raced = false
  const retryAt = NOW + 3600000
  const raceQuery = interceptQuery(async statement => {
    if (!raced && statement.sql.startsWith('INSERT INTO github_auth_cooldowns')) {
      raced = true
      await query({ sql: 'INSERT INTO github_auth_cooldowns(quota_key,retry_at) VALUES (?,?)', params: [statement.params[0]!, retryAt] })
    }
  })
  await expect(resolveGitHubAuth({ ...f.input, query: raceQuery })).rejects.toMatchObject({ code: 'rate_limited', retryAt })
  expect(f.diagnostics[0]).toMatchObject({ outcome: 'rate_limited', retryAt })
})

async function appFixture() {
  const descriptor: GitHubAuthDescriptor = {
    id: 'app-auth', revision: 1, keyRevision: 1, mode: 'app',
    appId: 42, installationId: 7, accountId: 50, fingerprint, keySecretName: 'GITHUB_APP_A',
    repositories: [REPOSITORY], managementWorkspaces: ['alpha', 'beta'],
    capabilities: ['repository-hooks-read', 'repository-hooks-write'], state: 'active',
  }
  await saveDescriptor(descriptor)
  const clock = { now: NOW }
  const counts = { mints: 0, verifications: 0 }
  const provider = { permission: 'write' }
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/access_tokens')) {
      counts.mints++
      return Response.json({ token: 'synthetic-resolver-app-' + counts.mints,
        expires_at: new Date(clock.now + GITHUB_APP_LIMITS.TOKEN_LIFETIME_MS).toISOString(),
        permissions: JSON.parse(String(init?.body)).permissions,
        repositories: [{ id: REPOSITORY.id, full_name: REPOSITORY.fullName, private: true, owner: { id: 50 } }],
      })
    }
    counts.verifications++
    return Response.json({ id: 7, app_id: 42, account: { id: 50 }, permissions: { repository_hooks: provider.permission }, suspended_at: null })
  })
  const input: GitHubAuthResolveInput = {
    query, selection: { mode: 'app', descriptorId: descriptor.id },
    workspaceId: 'alpha', callerId: 'caller', repositoryFullName: REPOSITORY.fullName,
    capability: 'repository-hooks-read', phase: 'read', now: () => clock.now,
    loadPrivateKey: async () => privateKey, fetch: fetcher,
  }
  return { input, descriptor, counts, clock, provider }
}

it.each(['workspace', 'caller'])('separates warm resolver tokens by %s without splitting quota', async dimension => {
  const f = await appFixture()
  const first = await resolveGitHubAuth(f.input)
  const second = await resolveGitHubAuth({ ...f.input,
    ...(dimension === 'workspace' ? { workspaceId: 'beta' } : { callerId: 'other-caller' }),
  })
  expect(second.token).not.toBe(first.token)
  expect(second.quotaKey).toBe(first.quotaKey)
  expect((await resolveGitHubAuth(f.input)).token).toBe(first.token)
  expect(f.counts).toEqual({ mints: 2, verifications: 1 })
})

it('keeps each descriptor token after another descriptor refreshes the same installation', async () => {
  const f = await appFixture()
  const first = await resolveGitHubAuth(f.input)
  await saveDescriptor({ ...f.descriptor, id: 'other-app' })
  const secondInput = { ...f.input, selection: { mode: 'app' as const, descriptorId: 'other-app' } }
  const second = await resolveGitHubAuth(secondInput)
  expect(second.token).not.toBe(first.token)
  expect((await resolveGitHubAuth(f.input)).token).toBe(first.token)
  expect((await resolveGitHubAuth(secondInput)).token).toBe(second.token)
  expect(f.counts).toEqual({ mints: 2, verifications: 2 })
})

it.each(['revision', 'key revision', 'generation'])('reuses only the newly verified token after %s changes', async dimension => {
  const f = await appFixture()
  const first = await resolveGitHubAuth(f.input)
  if (dimension === 'generation') await invalidateGitHubAuthAuthority(query, f.descriptor.id)
  else {
    const descriptor = { ...f.descriptor, revision: 2, keyRevision: dimension === 'key revision' ? 2 : 1 }
    await env.EVENTS_DB.prepare('UPDATE github_auth_descriptors SET revision=?,key_revision=?,metadata_json=?,write_id=? WHERE id=?')
      .bind(descriptor.revision, descriptor.keyRevision, JSON.stringify(descriptor), crypto.randomUUID(), descriptor.id).run()
  }
  const renewed = await resolveGitHubAuth(f.input)
  expect(renewed.token).not.toBe(first.token)
  expect(renewed.authorityIdentity).not.toBe(first.authorityIdentity)
  expect(renewed.quotaKey).toBe(first.quotaKey)
  expect((await resolveGitHubAuth(f.input)).token).toBe(renewed.token)
  expect(f.counts).toEqual({ mints: 2, verifications: 2 })
})

it('preserves identity on unchanged fresh verification and publishes its token for warm reads', async () => {
  const f = await appFixture()
  const first = await resolveGitHubAuth(f.input)
  expect((await resolveGitHubAuth(f.input)).token).toBe(first.token)
  expect(f.counts).toEqual({ mints: 1, verifications: 1 })
  f.clock.now += GITHUB_APP_LIMITS.AUTHORITY_AGE_MS + 1
  const refreshed = await resolveGitHubAuth(f.input)
  expect(refreshed.token).not.toBe(first.token)
  expect(refreshed.authorityIdentity).toBe(first.authorityIdentity)
  expect((await resolveGitHubAuth(f.input)).token).toBe(refreshed.token)
  const effect = await resolveGitHubAuth({ ...f.input, phase: 'effect' })
  expect(effect.token).not.toBe(refreshed.token)
  expect(effect.authorityIdentity).toBe(first.authorityIdentity)
  expect((await resolveGitHubAuth(f.input)).token).toBe(effect.token)
  expect(f.counts).toEqual({ mints: 3, verifications: 3 })
})

it('never accepts a speculative mint under another observation after losing authority CAS', async () => {
  const f = await appFixture()
  f.provider.permission = 'read'
  let raced = false
  let winningGeneration: number | undefined
  const raceQuery = interceptQuery(async statement => {
    if (!raced && statement.sql.startsWith('UPDATE github_auth_authority SET generation')) {
      raced = true
      f.provider.permission = 'write'
      const winner = await resolveGitHubAuth({ ...f.input, callerId: 'other-caller' })
      winningGeneration = winner.generation
    }
  })
  await expect(resolveGitHubAuth({ ...f.input, query: raceQuery })).rejects.toMatchObject({ code: 'conflict' })
  const warm = await resolveGitHubAuth(f.input)
  expect(warm.generation).toBe(winningGeneration)
  expect(warm.token).not.toBe('synthetic-resolver-app-1')
  expect(f.counts).toEqual({ mints: 3, verifications: 2 })
})
