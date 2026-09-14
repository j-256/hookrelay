import { z } from 'zod'
import { hmacSha256Hex } from './hmac'

export const GITHUB_SETUP_KEY = 'HOOK_SETUP_KEY'
export const GITHUB_SETUP_EVENTS = [
  'push',
  'pull_request',
  'issues',
  'release',
  'workflow_run',
  'check_run',
  'check_suite',
  'repository',
  'deployment_status',
] as const
export const githubSetupRepository = z
  .string()
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!))
export const githubSetupEvents = z
  .array(z.enum(GITHUB_SETUP_EVENTS))
  .min(1)
  .max(GITHUB_SETUP_EVENTS.length)
  .refine((values) => new Set(values).size === values.length)
export const githubSetupMetadata = z
  .object({
    resourceId: z.uuid(),
    repository: githubSetupRepository,
    events: githubSetupEvents,
    origin: z.url(),
    keyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export async function deriveGitHubSetupSecret(
  key: string,
  resourceId: string,
  purpose: 'route' | 'signature',
): Promise<string> {
  z.uuid().parse(resourceId)
  if (key.length < 32 || key.length > 4096)
    throw new Error('The setup key is unavailable')
  return hmacSha256Hex(
    key,
    new TextEncoder().encode(
      `hookrelay.github-setup.v1:${purpose}:${resourceId}`,
    ),
  )
}
