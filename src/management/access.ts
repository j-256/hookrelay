import { z } from 'zod'
import type { Env } from '../index'
import { MANAGEMENT_LIMITS, ManagementError, managementId } from './contract'

const credentialSchema = z.object({
  id: managementId,
  revision: z.number().int().positive(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  workspaceIds: z.array(managementId).min(1).max(20),
  capabilities: z.array(z.enum(['read', 'retry', 'configure', 'provision', 'resolve', 'handoff', 'custody'])).min(1).max(7)
    .refine(values => new Set(values).size === values.length),
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

export function readManagementCredentials(env: Env): ManagementPrincipal[] {
  function catalog(raw: string | undefined) {
    if (!raw || raw.length > MANAGEMENT_LIMITS.CREDENTIAL_BYTES) throw new Error()
    const values = z.array(credentialSchema).min(1).max(20).parse(JSON.parse(raw))
    if (new Set(values.map(value => value.id)).size !== values.length ||
        new Set(values.map(value => value.tokenHash)).size !== values.length) throw new Error()
    return values
  }
  let primary: ManagementPrincipal[]
  try { primary = catalog(env.MANAGEMENT_CREDENTIALS) } catch {
    throw new ManagementError('unconfigured', 503, 'Management credentials are not configured correctly')
  }
  let additional: ManagementPrincipal[] = []
  try {
    if (env.MANAGEMENT_CREDENTIALS_ADDITIONAL) additional = catalog(env.MANAGEMENT_CREDENTIALS_ADDITIONAL)
  } catch { return primary }
  return [...primary, ...additional.filter(value => !primary.some(existing =>
    existing.id === value.id || equalHash(existing.tokenHash, value.tokenHash)))]
}

export async function authenticateManagement(request: Request, env: Env): Promise<ManagementPrincipal> {
  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer (hkr_[A-Za-z0-9_-]{43})$/.exec(authorization)
  if (!match) throw new ManagementError('unauthorized', 401, 'A management credential is required')
  const credentials = readManagementCredentials(env)
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

export function authorizeConfiguration(principal: ManagementPrincipal, workspaceId: string): void {
  authorizeManagement(principal, workspaceId)
  if (!principal.capabilities.includes('configure')) {
    throw new ManagementError('forbidden', 403, 'The management credential does not permit configuration changes')
  }
}

export function authorizeResolution(principal: ManagementPrincipal, workspaceId: string): void {
  authorizeManagement(principal, workspaceId)
  if (!principal.capabilities.includes('resolve')) {
    throw new ManagementError('forbidden', 403, 'The management credential does not permit operational resolution')
  }
}

export function authorizeProvision(principal: ManagementPrincipal, workspaceId: string): void {
  authorizeManagement(principal, workspaceId)
  if (!principal.capabilities.includes('provision')) {
    throw new ManagementError('forbidden', 403, 'The management credential does not permit hook setup')
  }
}

export function authorizeHandoff(principal: ManagementPrincipal, workspaceId: string, custody = false): void {
  authorizeManagement(principal, workspaceId)
  if (!principal.capabilities.includes('handoff') || (custody && !principal.capabilities.includes('custody'))) {
    throw new ManagementError('forbidden', 403, 'The management credential does not permit this manual hook operation')
  }
}

export function assertCurrentManagementGrant(env:Env,principal:ManagementPrincipal,workspaceId:string,provision = true) {
  if (provision) authorizeProvision(principal,workspaceId)
  else authorizeManagement(principal,workspaceId)
  let current:ManagementPrincipal|undefined
  try {
    const credentials = readManagementCredentials(env)
    current = credentials.find(item => item.id === principal.id && item.revision === principal.revision && equalHash(item.tokenHash,principal.tokenHash))
  } catch { throw new ManagementError('unconfigured',503,'Management authorization is unavailable') }
  if (!current) throw new ManagementError('unauthorized',401,'Management authorization changed')
  if (provision) authorizeProvision(current,workspaceId)
  else authorizeManagement(current,workspaceId)
}
