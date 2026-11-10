import type { Env } from '../index'
import { configurationQuery } from '../configuration/authority'
import { readGitHubAuthDescriptor } from '../configuration/github-auth'
import { GitHubAuthError } from '../lib/github-app-contract'
import { authorizeManagement, type ManagementPrincipal } from './access'

export function githubRuntimeAuthSelection(env: Pick<Env, 'GITHUB_AUTH_MODE' | 'GITHUB_AUTH_DESCRIPTOR'>) {
  if (env.GITHUB_AUTH_MODE === undefined && env.GITHUB_AUTH_DESCRIPTOR === undefined) return null
  if (!['app', 'token'].includes(env.GITHUB_AUTH_MODE ?? '') || !env.GITHUB_AUTH_DESCRIPTOR) throw new GitHubAuthError('unavailable')
  return { mode: env.GITHUB_AUTH_MODE as 'app' | 'token', descriptorId: env.GITHUB_AUTH_DESCRIPTOR }
}
export async function readGitHubAuthStatus(env: Env, principal: ManagementPrincipal, input: { workspaceId: string; actorId: string }) {
  authorizeManagement(principal, input.workspaceId)
  const selection = githubRuntimeAuthSelection(env)
  if (!selection) {
    await configurationQuery(env.EVENTS_DB)({ sql: 'SELECT id FROM github_auth_descriptors LIMIT 1', params: [] })
    return { mode: 'token' as const, descriptorId: null, revision: null, state: env.HOOK_SETUP_GITHUB_TOKEN ? 'configured' : 'unavailable', repositoryNames: [], observedAt: new Date().toISOString() }
  }
  const descriptor = await readGitHubAuthDescriptor(configurationQuery(env.EVENTS_DB), selection)
  if (!descriptor.managementWorkspaces.includes(input.workspaceId)) throw new GitHubAuthError('denied')
  return { mode: descriptor.mode, descriptorId: descriptor.id, revision: descriptor.revision, state: descriptor.state, repositoryNames: descriptor.repositories.map(repo => repo.fullName), observedAt: new Date().toISOString() }
}
