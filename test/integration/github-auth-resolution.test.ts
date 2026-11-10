import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { configurationQuery } from '../../src/configuration/authority'
import {
  githubTokenFingerprint,
  resolveGitHubAuth,
  type GitHubAuthDiagnostic,
  type GitHubAuthResolveInput,
} from '../../src/lib/github-auth'
import type { GitHubAuthDescriptor } from '../../src/lib/github-app-contract'

const query = configurationQuery(env.EVENTS_DB)
const NOW = Date.parse('2026-11-10T12:00:00Z')
const TOKEN = 'synthetic-resolution-manual-token'
const REPOSITORY = { id: 101, fullName: 'owner/repo', ownerId: 50, private: true }

beforeAll(async () => {
  await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!)
})
beforeEach(async () => {
  await env.EVENTS_DB.exec('DELETE FROM github_auth_candidates; DELETE FROM github_auth_descriptors; DELETE FROM github_auth_cooldowns;')
})
async function saveDescriptor(descriptor: GitHubAuthDescriptor) {
  await env.EVENTS_DB.prepare(
    'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,?,?,?,?)',
  ).bind(descriptor.id, descriptor.revision, descriptor.keyRevision, JSON.stringify(descriptor), crypto.randomUUID()).run()
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

it.each([
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
