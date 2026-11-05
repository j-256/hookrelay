import { z } from 'zod'
import { GITHUB_EVENT_PROFILES, githubEventTypeFilter, parseGitHubEventSelection } from './github-event-profiles'
import { SUBSCRIPTION_SLUG_RE } from './subscription'

export const HANDOFF_KEYS = 'HOOK_HANDOFF_KEYS'
export const HANDOFF_PRIVATE_PATH = '/admin/api/v1/private/github-handoff'
export const HANDOFF_PROFILE_NAMES = ['activity', 'stars', 'alerts'] as const
export const handoffProfileSchema = z.enum(HANDOFF_PROFILE_NAMES)
export type HandoffProfile = z.infer<typeof handoffProfileSchema>
export const HANDOFF_PROFILES = Object.freeze({
  activity: { suffix: '', events: GITHUB_EVENT_PROFILES.activity, sink: 'discord:repo-activity' },
  stars: { suffix: ':stars', events: GITHUB_EVENT_PROFILES.stars, sink: 'discord:github-stars' },
  alerts: { suffix: ':alerts', events: GITHUB_EVENT_PROFILES.alerts, sink: 'discord:repo-alerts' },
})
export const handoffRepositorySchema = z.string().max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/)
  .refine(value => !['.', '..'].includes(value.split('/')[1]!))

export function normalizeHandoffRepository(value: string): { repository: string; key: string } {
  let repository = value.trim()
  if (/^https?:/i.test(repository)) {
    const match = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/?$/i.exec(repository)
    if (!match) throw new Error('Use an HTTPS github.com repository URL or owner/repository')
    repository = match[1]!
  }
  repository = handoffRepositorySchema.parse(repository)
  return { repository, key: repository.toLowerCase() }
}
export function handoffHmacName(repository: string): string {
  return `HMAC_GITHUB_${repository.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`
}
export function handoffSubscriptionName(repository: string, profile: HandoffProfile): string {
  return `github:${repository}${HANDOFF_PROFILES[profile].suffix}`
}
export function handoffProfileFilter(profile: HandoffProfile) {
  return githubEventTypeFilter(parseGitHubEventSelection(profile))
}
const slug = z.string().min(22).max(128).regex(SUBSCRIPTION_SLUG_RE)
export const handoffBundleSchema = z.object({
  version: z.literal(1),
  hmac: z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]*$/), value: z.string().min(1).max(4096) }).strict(),
  slugs: z.object({ activity: slug, stars: slug, alerts: slug }).strict(),
}).strict().refine(value => new Set(Object.values(value.slugs)).size === HANDOFF_PROFILE_NAMES.length)
export type HandoffBundle = z.infer<typeof handoffBundleSchema>
export const handoffMetadataSchema = z.object({
  authorityId: z.string().regex(/^[a-f0-9]{32}$/), workspaceId: z.string().min(1).max(240),
  repositoryId: z.uuid(), resourceId: z.uuid(), repository: handoffRepositorySchema, profile: handoffProfileSchema,
}).strict()
export type HandoffMetadata = z.infer<typeof handoffMetadataSchema>
export const handoffAuthSchema = z.object({
  scheme: z.literal('github-sha256'), secretEnv: z.literal(HANDOFF_KEYS), credentialId: z.uuid(),
  alternateSecretEnvs: z.never().optional(), derivationId: z.never().optional(),
}).strict()
export class HandoffUnavailableError extends Error {
  constructor() { super('Protected hook credentials are unavailable') }
}
