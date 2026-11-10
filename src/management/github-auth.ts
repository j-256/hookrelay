import type { Env } from '../index'
import { configurationQuery } from '../configuration/authority'
import {
  readGitHubAuthDescriptor,
  readGitHubRuntimePolicy,
  listGitHubRuntimeDescriptors,
} from '../configuration/github-auth'
import { GitHubAuthError } from '../lib/github-app-contract'
import { authorizeManagement, type ManagementPrincipal } from './access'

export function githubRuntimeAuthSelection(env: Pick<Env, 'GITHUB_AUTH_MODE' | 'GITHUB_AUTH_DESCRIPTOR'>) {
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
      selection = { mode: descriptors[0]!.mode as 'app' | 'token', descriptorId: descriptors[0]!.id }
    else
      return {
        mode: 'registry' as const,
        descriptorId: null,
        revision: policy.revision,
        state: descriptors.length ? 'configured' : 'unavailable',
        repositoryNames: descriptors.flatMap((item) => item.repositories.map((repo) => repo.fullName)),
        descriptors: descriptors.map((item) => ({ descriptorId: item.id, mode: item.mode, revision: item.revision })),
        observedAt: new Date().toISOString(),
      }
  }
  if (!selection) {
    return {
      mode: 'token' as const,
      descriptorId: null,
      revision: null,
      state: env.HOOK_SETUP_GITHUB_TOKEN ? 'configured' : 'unavailable',
      repositoryNames: [],
      observedAt: new Date().toISOString(),
    }
  }
  const descriptor = await readGitHubAuthDescriptor(configurationQuery(env.EVENTS_DB), selection)
  if (!descriptor.managementWorkspaces.includes(input.workspaceId)) throw new GitHubAuthError('denied')
  return {
    mode: descriptor.mode,
    descriptorId: descriptor.id,
    revision: descriptor.revision,
    state: descriptor.state,
    repositoryNames: descriptor.repositories.map((repo) => repo.fullName),
    observedAt: new Date().toISOString(),
  }
}
