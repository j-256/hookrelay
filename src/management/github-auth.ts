import type { Env } from '../index'
import { configurationQuery, configurationDigest } from '../configuration/authority'
import {
  readGitHubAuthDescriptor,
  readGitHubRuntimePolicy,
  listGitHubRuntimeDescriptors,
} from '../configuration/github-auth'
import { GitHubAuthError, GITHUB_APP_LIMITS } from '../lib/github-app-contract'
import { authorizeManagement, type ManagementPrincipal } from './access'
import {
  resolveGitHubAuth,
  recordGitHubAuthResponse,
  githubTokenFingerprint,
} from '../lib/github-auth'
import { assertGitHubAuthFence } from '../configuration/github-auth'
import { assertCurrentManagementGrant } from './access'
import type { GitHubAuthLease, GitHubHookCapability } from '../lib/github-app-contract'
import type { ManagementContext } from './contract'

export function githubRuntimeAuthSelection(
  env: Pick<Env, 'GITHUB_AUTH_MODE' | 'GITHUB_AUTH_DESCRIPTOR'>,
) {
  if (env.GITHUB_AUTH_MODE === undefined && env.GITHUB_AUTH_DESCRIPTOR === undefined) return null
  if (!['app', 'token'].includes(env.GITHUB_AUTH_MODE ?? '') || !env.GITHUB_AUTH_DESCRIPTOR)
    throw new GitHubAuthError('unavailable')
  return { mode: env.GITHUB_AUTH_MODE as 'app' | 'token', descriptorId: env.GITHUB_AUTH_DESCRIPTOR }
}
export async function readGitHubAuthStatus(
  env: Env,
  principal: ManagementPrincipal,
  input: { workspaceId: string; actorId: string },
) {
  authorizeManagement(principal, input.workspaceId)
  const query = configurationQuery(env.EVENTS_DB)
  let selection = githubRuntimeAuthSelection(env)
  const policy = await readGitHubRuntimePolicy(query)
  if (!selection && policy.mode === 'registry') {
    const descriptors = await listGitHubRuntimeDescriptors(query, input.workspaceId)
    if (descriptors.length === 1)
      selection = {
        mode: descriptors[0]!.mode as 'app' | 'token',
        descriptorId: descriptors[0]!.id,
      }
    else
      return {
        mode: 'registry' as const,
        descriptorId: null,
        revision: policy.revision,
        state: descriptors.length ? 'configured' : 'unavailable',
        repositoryNames: descriptors.flatMap((item) =>
          item.repositories.map((repo) => repo.fullName),
        ),
        descriptors: descriptors.map((item) => ({
          descriptorId: item.id,
          mode: item.mode,
          revision: item.revision,
          capabilities: item.capabilities,
        })),
        observedAt: new Date().toISOString(),
      }
  }
  if (!selection) {
    return {
      mode: 'token' as const,
      descriptorId: null,
      revision: null,
      state:
        env.HOOK_SETUP_GITHUB_TOKEN &&
        env.HOOK_SETUP_GITHUB_TOKEN.length <= GITHUB_APP_LIMITS.MANUAL_TOKEN_BYTES &&
        !/[\s\x00-\x1f\x7f]/.test(env.HOOK_SETUP_GITHUB_TOKEN)
          ? 'configured'
          : 'unavailable',
      repositoryNames: [],
      observedAt: new Date().toISOString(),
    }
  }
  const descriptor = await readGitHubAuthDescriptor(configurationQuery(env.EVENTS_DB), selection)
  if (!descriptor.managementWorkspaces.includes(input.workspaceId))
    throw new GitHubAuthError('denied')
  return {
    mode: descriptor.mode,
    descriptorId: descriptor.id,
    revision: descriptor.revision,
    state: descriptor.state,
    capabilities: descriptor.capabilities,
    repositoryNames: descriptor.repositories.map((repo) => repo.fullName),
    observedAt: new Date().toISOString(),
  }
}

export async function selectRuntimeGitHubAuth(
  env: Env,
  workspaceId: string,
  repositoryFullName: string,
  capability: GitHubHookCapability,
) {
  const query = configurationQuery(env.EVENTS_DB)
  const pinned = githubRuntimeAuthSelection(env)
  if (pinned) return pinned
  const policy = await readGitHubRuntimePolicy(query)
  if (policy.mode === 'legacy') return null
  const descriptors = (await listGitHubRuntimeDescriptors(query, workspaceId)).filter(
    (item) =>
      item.mode !== 'gh' &&
      item.repositories.some((repo) => repo.fullName === repositoryFullName) &&
      (item.capabilities.includes(capability) ||
        (capability === 'repository-hooks-read' &&
          item.capabilities.includes('repository-hooks-write'))),
  )
  if (descriptors.length !== 1 || descriptors[0]!.mode === 'gh') throw new GitHubAuthError('denied')
  return { mode: descriptors[0]!.mode, descriptorId: descriptors[0]!.id }
}
export type RuntimeGitHubAuthentication = {
  initial: GitHubAuthLease | null
  current: GitHubAuthLease | null
  identity: string | null
  renewable: boolean
  resolve(
    phase: 'read' | 'effect',
    signal: AbortSignal,
    refreshToken?: boolean,
  ): Promise<{ token: string; fence: GitHubAuthLease['fence'] | null }>
  assert(): Promise<void>
  recordResponse(response: Response): Promise<void>
}
export async function createRuntimeGitHubAuthentication(
  env: Env,
  principal: ManagementPrincipal,
  context: ManagementContext,
  repositoryFullName: string,
  provision = true,
): Promise<RuntimeGitHubAuthentication> {
  const query = configurationQuery(env.EVENTS_DB)
  const capability = provision
    ? ('repository-hooks-write' as const)
    : ('repository-hooks-read' as const)
  const selection = await selectRuntimeGitHubAuth(
    env,
    context.workspaceId,
    repositoryFullName,
    capability,
  )
  const callerId = await configurationDigest({
    clientId: principal.id,
    revision: principal.revision,
    actorId: context.actorId,
  })
  let initial: GitHubAuthLease | null = null
  let legacyHash: string | null = null
  const result: RuntimeGitHubAuthentication = {
    initial: null,
    current: null,
    identity: null,
    renewable: selection?.mode === 'app',
    resolve: async (phase, signal, refreshToken = false) => {
      assertCurrentManagementGrant(env, principal, context.workspaceId, provision)
      const selected = await selectRuntimeGitHubAuth(
        env,
        context.workspaceId,
        repositoryFullName,
        capability,
      )
      if (JSON.stringify(selected) !== JSON.stringify(selection) || signal.aborted)
        throw new GitHubAuthError('conflict')
      if (!selection) {
        const token = env.HOOK_SETUP_GITHUB_TOKEN ?? ''
        if (
          !token ||
          token.length > GITHUB_APP_LIMITS.MANUAL_TOKEN_BYTES ||
          /[\s\x00-\x1f\x7f]/.test(token)
        )
          throw new GitHubAuthError('unavailable')
        const digest = await githubTokenFingerprint(token)
        if (legacyHash && legacyHash !== digest) throw new GitHubAuthError('conflict')
        legacyHash = digest
        return { token, fence: null }
      }
      const started = Date.now()
      const lease = await resolveGitHubAuth({
        query,
        selection,
        workspaceId: context.workspaceId,
        callerId,
        repositoryFullName,
        capability,
        phase,
        refreshToken,
        signal,
        loadPrivateKey: async (descriptor) => {
          const key =
            descriptor.mode === 'app'
              ? (env as unknown as Record<string, unknown>)[descriptor.keySecretName]
              : undefined
          if (typeof key !== 'string') throw new GitHubAuthError('unavailable')
          return key
        },
        loadToken: async (descriptor) => {
          const value =
            descriptor.mode === 'token'
              ? (env as unknown as Record<string, unknown>)[descriptor.tokenSecretName]
              : undefined
          if (typeof value !== 'string') throw new GitHubAuthError('unavailable')
          return value
        },
        remainingBudgetMs: () =>
          signal.aborted ? 0 : Math.max(0, GITHUB_APP_LIMITS.REQUEST_MS - (Date.now() - started)),
      })
      if (initial && lease.authorityIdentity !== initial.authorityIdentity)
        throw new GitHubAuthError('conflict')
      initial ??= lease
      result.initial = initial
      result.current = lease
      result.identity = initial.authorityIdentity
      return { token: lease.token, fence: lease.fence }
    },
    assert: async () => {
      assertCurrentManagementGrant(env, principal, context.workspaceId, provision)
      if (
        JSON.stringify(
          await selectRuntimeGitHubAuth(env, context.workspaceId, repositoryFullName, capability),
        ) !== JSON.stringify(selection)
      )
        throw new GitHubAuthError('conflict')
      if (initial) await assertGitHubAuthFence(query, initial.fence)
      else if ((await githubTokenFingerprint(env.HOOK_SETUP_GITHUB_TOKEN ?? '')) !== legacyHash)
        throw new GitHubAuthError('conflict')
    },
    recordResponse: async (response) => {
      if (result.current) await recordGitHubAuthResponse(query, result.current.quotaKey, response)
    },
  }
  await result.resolve('read', AbortSignal.timeout(GITHUB_APP_LIMITS.REQUEST_MS))
  return result
}
