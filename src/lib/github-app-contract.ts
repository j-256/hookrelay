import { z } from 'zod'

export const GITHUB_APP_LIMITS = Object.freeze({
  JWT_SKEW_SECONDS: 60, JWT_LIFETIME_SECONDS: 540, AUTHORITY_AGE_MS: 60000,
  TOKEN_MARGIN_MS: 60000, TOKEN_LIFETIME_MS: 3600000, TOKEN_BYTES: 16384,
  CACHE_ENTRIES: 100, RESPONSE_BYTES: 262144, REQUEST_MS: 8000, COOLDOWN_MAX_MS: 86400000,
  MANUAL_TOKEN_BYTES: 4096, PRIVATE_BYTES: 65536, REPOSITORIES: 100, MIN_RSA_BITS: 2048,
})
export const githubProviderId = z.number().int().positive().safe()
export const githubAuthId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/)
export const githubRepository = z.object({
  id: githubProviderId, fullName: z.string().max(201).regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/), ownerId: githubProviderId, private: z.boolean(),
}).strict()
export const githubHookCapability = z.enum(['repository-hooks-read', 'repository-hooks-write'])
export type GitHubHookCapability = z.infer<typeof githubHookCapability>
const base = z.object({
  id: githubAuthId, revision: z.number().int().positive(), keyRevision: z.number().int().positive(),
  repositories: z.array(githubRepository).min(1).max(GITHUB_APP_LIMITS.REPOSITORIES).refine(rows => new Set(rows.map(row => row.id)).size === rows.length && new Set(rows.map(row => row.fullName.toLowerCase())).size === rows.length),
  managementWorkspaces: z.array(githubAuthId).min(1).max(100).refine(rows => new Set(rows).size === rows.length),
  capabilities: z.array(githubHookCapability).min(1).max(2).refine(rows => new Set(rows).size === rows.length),
  state: z.enum(['active', 'disconnected']),
})
export const githubAuthDescriptorSchema = z.discriminatedUnion('mode', [
  base.extend({ mode: z.literal('app'), appId: githubProviderId, installationId: githubProviderId, accountId: githubProviderId, keySecretName: z.string().regex(/^GITHUB_APP_[A-Z0-9_]{1,80}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  base.extend({ mode: z.literal('token'), tokenSecretName: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  base.extend({ mode: z.literal('gh') }).strict(),
])
export type GitHubAuthenticationMode = 'app' | 'token' | 'gh'
export type GitHubAuthDescriptor = z.infer<typeof githubAuthDescriptorSchema>
export type GitHubAuthFence = {
  descriptorId: string; revision: number; keyRevision: number; installationId: number | null;
  generation: number; workspaceId: string; callerId: string; repositoryId: number; repositoryFullName: string; capability: GitHubHookCapability
}
export type GitHubAuthLease = {
  token: string; authorityIdentity: string; quotaKey: string; validUntil: number; generation: number; fence: GitHubAuthFence
}
export type GitHubAuthProviderStage = 'installation' | 'installation_token'
export class GitHubAuthError extends Error {
  constructor(readonly code: 'validation' | 'conflict' | 'denied' | 'unavailable' | 'rate_limited' | 'not_sent' | 'indeterminate', readonly retryAt: number | null = null, readonly providerStage?: GitHubAuthProviderStage, readonly providerStatus?: number) {
    super(providerStage === 'installation_token' && providerStatus === 422 ? 'GitHub rejected the requested installation token scope; check repository selection and App permissions before preparing a new review' : 'GitHub authentication ' + code + '; inspect the selected authority and reconcile uncertain operations before retrying')
  }
}

export function githubAuthSecretName(descriptor:GitHubAuthDescriptor):string {
  if(descriptor.mode==='app')return descriptor.keySecretName
  if(descriptor.mode==='token')return descriptor.tokenSecretName
  throw new GitHubAuthError('validation')
}
