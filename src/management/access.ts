import { z } from 'zod'
import type { Env } from '../index'
import { MANAGEMENT_LIMITS, ManagementError, managementId } from './contract'

const credentialSchema = z.object({
  id: managementId,
  revision: z.number().int().positive(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  workspaceIds: z.array(managementId).min(1).max(20),
  capabilities: z.array(z.enum(['read', 'retry'])).min(1).max(2),
}).strict()
export type ManagementPrincipal = z.infer<typeof credentialSchema>

export async function managementTokenHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function equalHash(left: string, right: string): boolean {
  let different = left.length ^ right.length
  for (let index = 0; index < 64; index += 1) {
    different |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return different === 0
}

export async function authenticateManagement(request: Request, env: Env): Promise<ManagementPrincipal> {
  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer (hkr_[A-Za-z0-9_-]{43})$/.exec(authorization)
  if (!match) throw new ManagementError('unauthorized', 401, 'A management credential is required')
  const raw = env.MANAGEMENT_CREDENTIALS
  if (!raw || raw.length > MANAGEMENT_LIMITS.CREDENTIAL_BYTES) {
    throw new ManagementError('unconfigured', 503, 'Management credentials are not configured')
  }
  let credentials: ManagementPrincipal[]
  try {
    credentials = z.array(credentialSchema).min(1).max(20).parse(JSON.parse(raw))
    if (new Set(credentials.map(value => value.id)).size !== credentials.length ||
        new Set(credentials.map(value => value.tokenHash)).size !== credentials.length) throw new Error()
  } catch {
    throw new ManagementError('unconfigured', 503, 'Management credentials are not configured correctly')
  }
  const digest = await managementTokenHash(match[1]!)
  const principal = credentials.find(value => equalHash(value.tokenHash, digest))
  if (!principal || Date.parse(principal.expiresAt) <= Date.now()) {
    throw new ManagementError('unauthorized', 401, 'The management credential is invalid or expired')
  }
  return principal
}

export function authorizeManagement(principal: ManagementPrincipal, workspaceId: string, retry = false): void {
  if (Date.parse(principal.expiresAt) <= Date.now()) {
    throw new ManagementError('unauthorized', 401, 'The management credential is expired')
  }
  if (!principal.workspaceIds.includes(workspaceId)) {
    throw new ManagementError('not_found', 404, 'Workspace not found')
  }
  if (!principal.capabilities.includes('read') || (retry && !principal.capabilities.includes('retry'))) {
    throw new ManagementError('forbidden', 403, 'The management credential does not permit this operation')
  }
}
