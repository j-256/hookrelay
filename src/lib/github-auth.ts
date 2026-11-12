import { configurationDigest } from '../configuration/authority'
import { type GitHubAuthDescriptor, type GitHubHookCapability } from './github-app-contract'
import { z } from 'zod'
import type { ConfigurationQuery, ConfigurationStatement } from '../configuration/authority'
import {
  readGitHubAuthDescriptor,
  readGitHubAuthAuthority,
  recordGitHubAuthAuthority,
  invalidateGitHubAuthAuthority,
  assertGitHubAuthFence,
  assertGitHubAuthCooldown,
  recordGitHubAuthCooldown,
  type GitHubAuthSelection,
} from '../configuration/github-auth'
import {
  GITHUB_APP_LIMITS,
  GitHubAuthError,
  githubAuthId,
  type GitHubAuthLease,
} from './github-app-contract'
import {
  mintGitHubInstallationToken,
  githubHookPermissions,
  verifyGitHubInstallation,
  readGitHubAppJson,
} from './github-app-token'
import { fetchGitHubWithDeadline } from './github-http'
import { githubRetryAt } from './github-rate-limit'

export { githubAuthDescriptorSchema, GitHubAuthError } from './github-app-contract'
export async function githubAuthIdentity(
  descriptor: GitHubAuthDescriptor,
  generation: number,
  workspaceId: string,
  callerId: string,
  repositoryId: number,
  capability: GitHubHookCapability,
) {
  return {
    authorityIdentity: await configurationDigest({
      descriptor,
      generation,
      workspaceId,
      callerId,
      repositoryId,
      capability,
    }),
    quotaKey: await configurationDigest(
      descriptor.mode === 'app'
        ? ['github-app', descriptor.appId, descriptor.installationId]
        : descriptor.mode === 'token'
          ? ['github-token', descriptor.fingerprint]
          : ['github-gh', descriptor.id],
    ),
  }
}

export type GitHubAuthDiagnostic = {
  level: 'info' | 'warn'
  msg: 'github.auth.completed'
  correlationId: string
  mode: GitHubAuthDescriptor['mode'] | null
  descriptorId: string | null
  revision: number | null
  keyRevision: number | null
  phase: 'read' | 'effect'
  capability: GitHubHookCapability
  outcome: 'allowed' | GitHubAuthError['code']
  durationMs: number
  providerRequests: number
  d1Requests: number
  retryAt: number | null
  providerStage?: GitHubAuthError['providerStage']
  providerStatus?: number
}
export type GitHubAuthResolveInput = {
  diagnostic?: (event: GitHubAuthDiagnostic) => void
  correlationId?: string
  onProviderRequest?: () => void
  query: ConfigurationQuery
  selection: GitHubAuthSelection
  workspaceId: string
  callerId: string
  repositoryFullName: string
  capability: GitHubHookCapability
  phase: 'read' | 'effect'
  refreshToken?: boolean
  loadPrivateKey?: (descriptor: GitHubAuthDescriptor) => Promise<string>
  loadToken?: (descriptor: GitHubAuthDescriptor) => Promise<string>
  now?: () => number
  fetch?: typeof fetch
  remainingBudgetMs?: () => number
  signal?: AbortSignal
}
export async function githubTokenFingerprint(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function recordGitHubAuthResponse(
  query: ConfigurationQuery,
  quotaKey: string,
  response: Response,
  now = Date.now(),
) {
  const retryAt = githubRetryAt(response, now)
  if (retryAt !== null) await recordGitHubAuthCooldown(query, quotaKey, retryAt, now)
}
export async function resolveGitHubAuth(input: GitHubAuthResolveInput): Promise<GitHubAuthLease> {
  const started = Date.now()
  const stats = {
    revision: null as number | null,
    keyRevision: null as number | null,
    providerRequests: 0,
    d1Requests: 0,
  }
  let outcome: GitHubAuthDiagnostic['outcome'] = 'unavailable'
  let retryAt: number | null = null
  let providerError: GitHubAuthError | undefined
  const countedQuery: ConfigurationQuery = async <Row>(statement: ConfigurationStatement) => {
    stats.d1Requests++
    return input.query<Row>(statement)
  }
  try {
    const result = await resolveGitHubAuthLease(
      {
        ...input,
        query: countedQuery,
        onProviderRequest: () => {
          stats.providerRequests++
          try {
            input.onProviderRequest?.()
          } catch {}
        },
      },
      stats,
    )
    outcome = 'allowed'
    return result
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      outcome = error.code
      retryAt = error.retryAt
      providerError = error
    }
    throw error
  } finally {
    try {
      input.diagnostic?.({
        level: outcome === 'allowed' ? 'info' : 'warn',
        msg: 'github.auth.completed',
        correlationId: z.uuid().safeParse(input.correlationId).success
          ? input.correlationId!
          : crypto.randomUUID(),
        mode: ['app', 'token', 'gh'].includes(input.selection?.mode)
          ? (input.selection.mode as GitHubAuthDescriptor['mode'])
          : null,
        descriptorId: githubAuthId.safeParse(input.selection?.descriptorId).success
          ? input.selection.descriptorId
          : null,
        phase: input.phase,
        capability: input.capability,
        outcome,
        durationMs: Math.max(0, Date.now() - started),
        ...stats,
        retryAt,
        ...(providerError ? { providerStage: providerError.providerStage, providerStatus: providerError.providerStatus } : {}),
      })
    } catch {}
  }
}
async function resolveGitHubAuthLease(
  input: GitHubAuthResolveInput,
  stats: { revision: number | null; keyRevision: number | null },
): Promise<GitHubAuthLease> {
  if (
    !githubAuthId.safeParse(input.workspaceId).success ||
    !githubAuthId.safeParse(input.callerId).success ||
    !['read', 'effect'].includes(input.phase) ||
    !['repository-hooks-read', 'repository-hooks-write'].includes(input.capability)
  )
    throw new GitHubAuthError('validation')
  const clock = input.now ?? Date.now
  const descriptor = await readGitHubAuthDescriptor(input.query, input.selection)
  stats.revision = descriptor.revision
  stats.keyRevision = descriptor.keyRevision
  const repository = descriptor.repositories.find(
    (repo) => repo.fullName === input.repositoryFullName,
  )
  const capability = input.capability
  if (
    !repository ||
    ['.', '..'].includes(repository.fullName.split('/')[1]!) ||
    !descriptor.managementWorkspaces.includes(input.workspaceId) ||
    !(
      descriptor.capabilities.includes(capability) ||
      (capability === 'repository-hooks-read' &&
        descriptor.capabilities.includes('repository-hooks-write'))
    )
  )
    throw new GitHubAuthError('denied')
  const scope = await githubAuthIdentity(
    descriptor,
    0,
    input.workspaceId,
    input.callerId,
    repository.id,
    capability,
  )
  await assertGitHubAuthCooldown(input.query, scope.quotaKey, clock())
  const observedAt = clock()
  const before = await readGitHubAuthAuthority(input.query, descriptor, repository.id, capability)
  let token: string
  let tokenExpiresAt = clock() + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS
  let digest = before.digest
  let cacheGeneration = before.generation
  let appIdentity: Awaited<ReturnType<typeof githubAuthIdentity>> | undefined
  let fresh =
    input.phase === 'effect' ||
    input.refreshToken === true ||
    before.state !== 'allowed' ||
    !before.validUntil ||
    before.validUntil <= clock()
  try {
    if (descriptor.mode === 'app') {
      if (!input.loadPrivateKey) throw new GitHubAuthError('unavailable')
      const privateKey = await input.loadPrivateKey(descriptor)
      const request = {
        ...descriptor,
        privateKey,
        repositories: [repository],
        capability,
        now: clock,
        fetch: input.fetch,
        remainingBudgetMs: input.remainingBudgetMs,
        signal: input.signal,
        onProviderRequest: input.onProviderRequest,
      }
      const installation = fresh ? await verifyGitHubInstallation(request) : null
      if (installation) {
        // Token validation pins these permissions; CAS must confirm the predicted generation
        digest = await configurationDigest({
          installation,
          repository,
          capability,
          permissions: githubHookPermissions(capability),
        })
        if (before.digest !== digest || before.state !== 'allowed') cacheGeneration++
      }
      appIdentity = await githubAuthIdentity(
        descriptor,
        cacheGeneration,
        input.workspaceId,
        input.callerId,
        repository.id,
        capability,
      )
      const minted = await mintGitHubInstallationToken({
        ...request,
        authorityIdentity: await configurationDigest({
          authorityIdentity: appIdentity.authorityIdentity,
          observationDigest: digest,
        }),
        cache: fresh ? 'refresh' : true,
      })
      token = minted.token
      tokenExpiresAt = minted.expiresAt
    } else {
      if (!input.loadToken) throw new GitHubAuthError('unavailable')
      token = await input.loadToken(descriptor)
      if (
        !token ||
        token.length > GITHUB_APP_LIMITS.MANUAL_TOKEN_BYTES ||
        /[\s\x00-\x1f\x7f]/.test(token) ||
        (descriptor.mode === 'token' &&
          (await githubTokenFingerprint(token)) !== descriptor.fingerprint)
      )
        throw new GitHubAuthError('denied')
      const budget = Math.min(
        GITHUB_APP_LIMITS.REQUEST_MS,
        input.remainingBudgetMs?.() ?? GITHUB_APP_LIMITS.REQUEST_MS,
      )
      if (budget <= 0) throw new GitHubAuthError('not_sent')
      const timeout = AbortSignal.timeout(Math.max(1, Math.floor(budget)))
      const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout
      const response = await fetchGitHubWithDeadline(
        input.fetch ?? fetch,
        'https://api.github.com/repos/' + repository.fullName,
        {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: {
            authorization: 'Bearer ' + token,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'Hookrelay',
          },
        },
        input.onProviderRequest,
      )
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        const retryAt = githubRetryAt(response, clock())
        if (retryAt !== null) throw new GitHubAuthError('rate_limited', retryAt)
        throw new GitHubAuthError('denied')
      }
      const observed = z
        .object({
          id: z.number().int().positive(),
          full_name: z.string(),
          private: z.boolean(),
          owner: z.object({ id: z.number().int().positive() }),
        })
        .parse(await readGitHubAppJson(response, signal))
      if (
        observed.id !== repository.id ||
        observed.full_name !== repository.fullName ||
        observed.private !== repository.private ||
        observed.owner.id !== repository.ownerId
      )
        throw new GitHubAuthError('denied')
      digest = await configurationDigest({
        observed,
        credential: await githubTokenFingerprint(token),
        capability,
      })
      fresh = true
    }
  } catch (error) {
    let reportedError = error
    if (error instanceof GitHubAuthError && error.code === 'rate_limited') {
      const retryAt = await recordGitHubAuthCooldown(
        input.query,
        scope.quotaKey,
        error.retryAt ?? clock() + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS,
        clock(),
      )
      reportedError = new GitHubAuthError('rate_limited', retryAt, error.providerStage, error.providerStatus)
    }
    if (fresh) await invalidateGitHubAuthAuthority(input.query, descriptor.id)
    if (reportedError instanceof GitHubAuthError) throw reportedError
    throw new GitHubAuthError('unavailable')
  }
  if (!digest) throw new GitHubAuthError('unavailable')
  const now = clock()
  const validUntil = Math.min(
    tokenExpiresAt,
    observedAt + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS,
    fresh ? Infinity : (before.validUntil ?? 0),
  )
  const authority = fresh
    ? await recordGitHubAuthAuthority(input.query, {
        descriptor,
        repositoryId: repository.id,
        capability,
        expectedGeneration: before.generation,
        digest,
        state: 'allowed',
        validUntil,
        now,
      })
    : before
  if (descriptor.mode === 'app' && authority.generation !== cacheGeneration)
    throw new GitHubAuthError('conflict')
  const fence = {
    descriptorId: descriptor.id,
    revision: descriptor.revision,
    keyRevision: descriptor.keyRevision,
    installationId: descriptor.mode === 'app' ? descriptor.installationId : null,
    generation: authority.generation,
    workspaceId: input.workspaceId,
    callerId: input.callerId,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    capability,
  }
  await assertGitHubAuthFence(input.query, fence, clock())
  const identity = appIdentity ?? await githubAuthIdentity(
    descriptor,
    authority.generation,
    input.workspaceId,
    input.callerId,
    repository.id,
    capability,
  )
  return { token, validUntil, generation: authority.generation, fence, ...identity }
}
