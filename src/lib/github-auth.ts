import { configurationDigest } from '../configuration/authority'
import { type GitHubAuthDescriptor, type GitHubHookCapability } from './github-app-contract'
export { githubAuthDescriptorSchema, GitHubAuthError } from './github-app-contract'
export async function githubAuthIdentity(descriptor: GitHubAuthDescriptor, generation: number, workspaceId: string, callerId: string, repositoryId: number, capability: GitHubHookCapability) {
  return {
    authorityIdentity: await configurationDigest({ descriptor, generation, workspaceId, callerId, repositoryId, capability }),
    quotaKey: await configurationDigest(descriptor.mode === 'app' ? ['github-app', descriptor.appId, descriptor.installationId] : ['github-' + descriptor.mode, descriptor.id, descriptor.mode === 'token' ? descriptor.fingerprint : null]),
  }
}
