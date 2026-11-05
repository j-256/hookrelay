import { z } from 'zod'
import type { Env } from '../index'
import { ConfigurationError } from '../configuration/authority'
import { HANDOFF_PROFILES, HandoffUnavailableError } from '../lib/github-handoff'
import { verifyHandoffResources, type HandoffRepositoryRow } from '../lib/github-handoff-store'
import { authenticateManagement, authorizeHandoff } from './access'
import { handoffPrivateInputs } from './github-handoff-contract'
import { handoffOrigin, handoffReceivers, ownedHandoffReceiver, ownedHandoffRepository, planHandoffAdoption } from './github-handoff'
import { ManagementError, managementResponse, readManagementBody } from './contract'

const PRIVATE_RESPONSE_BYTES = 128 * 1024
const envelope = z.object({ action: z.enum(['adopt_plan', 'reveal', 'export']), input: z.unknown() }).strict()
async function verifiedResources(env: Env, row: HandoffRepositoryRow) {
  if (row.origin !== handoffOrigin(env)) throw new HandoffUnavailableError()
  const resources = await handoffReceivers(env, row)
  if (!resources.length) throw new ConfigurationError('not_found', 'No accepted manual hook receiver was found')
  const bundle = await verifyHandoffResources(env, row, resources)
  return { bundle, resources }
}
export async function revealHandoff(env: Env, workspaceId: string, resourceId: string) {
  const { repository, receiver } = await ownedHandoffReceiver(env, workspaceId, resourceId)
  const { bundle } = await verifiedResources(env, repository)
  const url = `${repository.origin}/hook/github/${bundle.slugs[receiver.profile]}`
  const events = [...HANDOFF_PROFILES[receiver.profile].events]
  return { resourceId, repository: repository.repository, profile: receiver.profile, url, secret: bundle.hmac.value, events,
    contentType: 'application/json', sslVerification: true, settingsUrl: `https://github.com/${repository.repository}/settings/hooks/new` }
}
export async function exportHandoff(env: Env, workspaceId: string, repositoryId: string) {
  const row = await ownedHandoffRepository(env, workspaceId, repositoryId)
  const { bundle, resources } = await verifiedResources(env, row)
  return { version: 1, repository: row.repository, record: {
    hmac: bundle.hmac, slugs: bundle.slugs, profiles: resources.map(resource => resource.profile), state: 'active',
    provider: { kind: 'hookrelay-handoff-v1', authorityId: row.authority_id, workspaceId: row.workspace_id, repositoryId: row.id, bundleRevision: row.bundle_revision,
      resources: Object.fromEntries(resources.map(resource => [resource.profile, { resourceId: resource.resourceId, authMode: resource.authMode }])) },
  }, routes: resources.map(resource => ({ ...JSON.parse(resource.value), slugHash: resource.key.slice('sub:sha256:'.length),
    setup: { github: { repo: row.repository, eventProfiles: [resource.profile] } } })), exportedAt: new Date().toISOString() }
}
export async function handleHandoffPrivate(request: Request, env: Env): Promise<Response> {
  const started = Date.now()
  const correlationId = crypto.randomUUID()
  try {
    const principal = await authenticateManagement(request, env)
    if (request.method !== 'POST') {
      const response = managementResponse({ error: { code: 'method', message: 'Use POST' } }, 405)
      response.headers.set('allow', 'POST')
      return response
    }
    const parsed = envelope.parse(await readManagementBody(request))
    const input = handoffPrivateInputs[parsed.action].parse(parsed.input)
    authorizeHandoff(principal, input.workspaceId, true)
    let result: unknown
    if (parsed.action === 'adopt_plan') result = await planHandoffAdoption(env, principal, input)
    else if (parsed.action === 'reveal') result = await revealHandoff(env, input.workspaceId, handoffPrivateInputs.reveal.parse(input).resourceId)
    else result = await exportHandoff(env, input.workspaceId, handoffPrivateInputs.export.parse(input).repositoryId)
    authorizeHandoff(principal, input.workspaceId, true)
    const text = JSON.stringify(result)
    if (new TextEncoder().encode(text).length > PRIVATE_RESPONSE_BYTES) throw new HandoffUnavailableError()
    await env.EVENTS_DB.prepare('INSERT INTO github_handoff_access(id,client_id,workspace_id,actor_id,action,created_at) VALUES(?,?,?,?,?,?)')
      .bind(correlationId, principal.id, input.workspaceId, input.actorId, parsed.action, new Date().toISOString()).run()
    console.log(JSON.stringify({ level: 'info', msg: 'handoff.private.accepted', correlationId, action: parsed.action, elapsedMs: Date.now() - started }))
    return managementResponse(result)
  } catch (error) {
    const code = error instanceof ConfigurationError || error instanceof ManagementError ? error.code : error instanceof z.ZodError ? 'validation' : 'unavailable'
    const status = error instanceof ManagementError ? error.status : code === 'not_found' ? 404 : code === 'conflict' || code === 'expired' ? 409 : code === 'validation' ? 400 : 503
    console.log(JSON.stringify({ level: 'warn', msg: 'handoff.private.rejected', correlationId, code, elapsedMs: Date.now() - started }))
    return managementResponse({ error: { code, message: 'Private hook access could not complete; retain the original review for recovery' }, correlationId }, status)
  }
}
