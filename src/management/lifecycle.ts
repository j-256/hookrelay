import { z } from 'zod'
import type { Env } from '../index'
import { CONFIGURATION_LIMITS, ConfigurationError, acceptConfigurationChange, configurationDigest, configurationQuery, readConfigurationEntries, readConfigurationReceipt, readConfigurationState, type ConfigurationEntry } from '../configuration/authority'
import { handoffKeyStatus } from '../lib/github-handoff-crypto'
import { parseDestinationPrivate, sealDestination } from '../lib/destination-custody'
import { authenticateManagement, assertCurrentManagementGrant, authorizeConfiguration, authorizeManagement, authorizeProvision, readManagementCredentials, type ManagementPrincipal } from './access'
import { ManagementError, managementResponse, readManagementBody, type ManagementContext } from './contract'
import { lifecycleInputs, LIFECYCLE_INPUT_PATH, type LifecycleInput } from './lifecycle-contract'
import { readGitHubAuthStatus } from './github-auth'
import { planLifecycleHook, applyLifecycleHook, reconcileLifecycleHook } from './lifecycle-github'
export interface LifecycleRow {
  id:string;client_id:string;client_revision:number;workspace_id:string;actor_id:string;authority_id:string;revision:number;resource_id:string;
  input_hash:string;input_json:string;before_json:string;after_json:string;entry_json:string;affected_json:string;auth_identity:string|null;auth_fence_json:string|null;hook_before_hash:string|null;
  private_required:number;private_received:number;state:string;outcome_json:string|null;error_code:string|null;hook_operation_id:string|null;created_at:string;expires_at:string;updated_at:string;
}
const timestamp = () => new Date().toISOString()
const owner = (principal:ManagementPrincipal,context:ManagementContext) => ({clientId:principal.id,clientRevision:principal.revision,...context})
export const lifecycleConflict = () => new ConfigurationError('conflict','Configuration or authority changed; retain the original review and prepare a fresh review')
function inputOf(row:LifecycleRow) { return lifecycleInputs.lifecycle_plan.parse(JSON.parse(row.input_json)) }
function authorizeLifecycle(env:Env,principal:ManagementPrincipal,context:ManagementContext,change:LifecycleInput['change'],privateInput=false) {
  assertCurrentManagementGrant(env,principal,context.workspaceId,false)
  const current=readManagementCredentials(env).find(item=>item.id===principal.id && item.revision===principal.revision && item.tokenHash===principal.tokenHash)!
  if (change.kind.startsWith('destination-') || change.kind.startsWith('github-')) authorizeProvision(current,context.workspaceId)
  if (change.kind.startsWith('subscription-')) authorizeConfiguration(current,context.workspaceId)
  if(privateInput && !current.capabilities.includes('custody')) throw new ManagementError('forbidden',403,'Protected destination input requires custody permission')
}
export async function findLifecycle(env:Env,principal:ManagementPrincipal,context:ManagementContext,id:string) {
  const row = await env.EVENTS_DB.prepare('SELECT * FROM lifecycle_reviews WHERE id=?').bind(id).first<LifecycleRow>()
  if(row && (row.client_id!==principal.id || row.client_revision!==principal.revision || row.workspace_id!==context.workspaceId || row.actor_id!==context.actorId)) throw new ConfigurationError('not_found','Lifecycle review not found')
  return row
}
export async function lifecycleResult(env:Env,principal:ManagementPrincipal,context:ManagementContext,row:LifecycleRow) {
  const input = inputOf(row)
  let state = row.state
  let outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null
  if (!input.change.kind.startsWith('github-')) {
    const receipt = await readConfigurationReceipt(configurationQuery(env.EVENTS_DB),row.id,owner(principal,context))
    if(receipt) { state='applied';outcome={configuration:'applied',upstream:'not_requested'} }
  }
  if(state==='ready' && Date.parse(row.expires_at)<=Date.now()) state='expired'
  return {id:row.id,authorityId:row.authority_id,revision:row.revision,fingerprint:row.input_hash,state,change:input.change,before:JSON.parse(row.before_json),after:JSON.parse(row.after_json),affectedSubscriptions:JSON.parse(row.affected_json),privateInputRequired:Boolean(row.private_required),privateInputReceived:Boolean(row.private_received),expiresAt:row.expires_at,outcome,observedAt:timestamp()}
}
export async function readLifecycleConfiguration(env:Env,principal:ManagementPrincipal,context:ManagementContext) {
  authorizeManagement(principal,context.workspaceId)
  const state = await readConfigurationState(configurationQuery(env.EVENTS_DB))
  const active=state.mode==='active'
  const canProvision=active && principal.capabilities.includes('provision')
  const canConfigure=active && principal.capabilities.includes('configure')
  const canSupplyPrivate=canProvision && principal.capabilities.includes('custody') && handoffKeyStatus(env)
  let provider=false
  try {
    const status=await readGitHubAuthStatus(env,principal,context)
    provider=status.state==='configured' || status.state==='active'
    if ('capabilities' in status && status.capabilities && !status.capabilities.includes('repository-hooks-write')) provider=false
    if ('descriptors' in status && status.descriptors && !status.descriptors.some(item=>item.capabilities.includes('repository-hooks-write'))) provider=false
    const origin=new URL(env.HOOK_SETUP_ORIGIN ?? '')
    provider=provider && origin.protocol==='https:' && origin.pathname==='/' && !origin.username && !origin.password && !origin.search && !origin.hash
  } catch { provider=false }
  const reason=!active?'inactive':!canProvision && !canConfigure?'grant_required':canProvision && !canSupplyPrivate?'custody_required':'ready'
  return {...state,canProvision,canConfigure,canSupplyPrivate,canManageHooks:canProvision && provider,reason,observedAt:timestamp()}
}
function safeSummary(entry:ConfigurationEntry) {
  const value=JSON.parse(entry.value) as Record<string,unknown>
  const name=z.string().min(1).max(160).parse(entry.namespace==='SINKS'?entry.key.slice(5):value.name)
  return {resourceId:entry.resourceId,name,...(entry.namespace==='SINKS'?{type:z.enum(['discord','ntfy','webhook']).parse(value.type)}:{}),retired:Boolean(entry.retired)}
}
export async function planLifecycle(env:Env,principal:ManagementPrincipal,input:LifecycleInput) {
  const context={workspaceId:input.workspaceId,actorId:input.actorId}
  authorizeLifecycle(env,principal,context,input.change)
  const fingerprint=await configurationDigest({...input,...owner(principal,context)})
  const previous=await findLifecycle(env,principal,context,input.planId)
  if(previous) {
    if(previous.input_hash!==fingerprint) throw lifecycleConflict()
    return lifecycleResult(env,principal,context,previous)
  }
  const query=configurationQuery(env.EVENTS_DB)
  const state=await readConfigurationState(query)
  if(state.mode!=='active' || state.authorityId!==input.authorityId || state.revision!==input.revision) throw lifecycleConflict()
  const entries=await readConfigurationEntries(query)
  const change=input.change
  let entry:ConfigurationEntry
  let before:unknown=null
  let after:unknown
  let affected:{resourceId:string;name:string}[]=[]
  let privateRequired=false
  let hook:{identity:string|null;fence:string|null;beforeHash:string|null}|undefined
  if(change.kind==='destination-create') {
    if(entries.some(entry=>entry.namespace==='SINKS' && entry.key===`sink:${change.name}`)) throw new ConfigurationError('conflict','A destination already uses that name')
    entry={namespace:'SINKS',key:`sink:${change.name}`,resourceId:crypto.randomUUID(),retired:false,value:JSON.stringify({type:change.type})}
    after=safeSummary(entry)
    privateRequired=true
  } else {
    const found=entries.find(entry=>entry.resourceId===change.resourceId && (change.kind.startsWith('destination-')?entry.namespace==='SINKS':entry.namespace==='SUBS' && entry.key.startsWith('sub:sha256:')))
    if(!found) throw new ConfigurationError('not_found','Lifecycle resource not found')
    entry=found
    before=safeSummary(entry)
    const value=JSON.parse(entry.value) as Record<string,unknown>
    if(change.kind.startsWith('github-')) {
      const planned=await planLifecycleHook(env,principal,context,change,entry)
      before=planned.before;after=planned.after;hook=planned.auth
    } else if(change.kind==='destination-update') {
      if(entry.retired) throw new ConfigurationError('conflict','Restore the destination before updating it')
      privateRequired=change.replaceCredentials
      after=safeSummary(entry)
    } else {
      const retired=change.kind.endsWith('-retire')
      if(Boolean(entry.retired)===retired) throw new ConfigurationError('conflict','The lifecycle state is unchanged')
      if(change.kind==='destination-retire') {
        affected=await query<{resourceId:string;name:string}>({
          sql:`SELECT resource_id AS resourceId,json_extract(value,'$.name') AS name FROM configuration_entries
            WHERE namespace='SUBS' AND entry_key LIKE 'sub:sha256:%' AND json_extract(value,'$.enabled')=1
              AND EXISTS(SELECT 1 FROM json_each(configuration_entries.value,'$.sinks') AS selected WHERE selected.value=?)
            ORDER BY resource_id LIMIT ?`,
          params:[entry.key.slice(5),CONFIGURATION_LIMITS.PAGE_SIZE+1],
        })
        const operations=entries.find(candidate=>candidate.key==='config:operations')
        if(operations && (JSON.parse(operations.value).sinks as string[]).includes(entry.key.slice(5))) throw new ConfigurationError('conflict','Enabled subscriptions or operational alerts still select this destination; unlink it through routing controls first')
        if(affected.length>CONFIGURATION_LIMITS.PAGE_SIZE) throw new ConfigurationError('validation','Too many affected subscriptions; unlink destinations before retirement')
      }
      entry={...entry,retired,...(entry.namespace==='SUBS'?{value:JSON.stringify({...value,enabled:false})}:{})}
      after=safeSummary(entry)
    }
  }
  if(privateRequired && (!principal.capabilities.includes('custody') || !handoffKeyStatus(env))) throw new ManagementError('custody_required',409,'Destination custody and permission are required')
  if(privateRequired) {
    const value=JSON.parse(entry.value)
    entry={...entry,value:JSON.stringify({type:value.type,custody:{resourceId:entry.resourceId,revision:state.revision+1}})}
  }
  const now=timestamp()
  const expiresAt=new Date(Math.min(Date.now()+CONFIGURATION_LIMITS.REVIEW_TTL_MS,Date.parse(principal.expiresAt))).toISOString()
  authorizeLifecycle(env,principal,context,input.change)
  await env.EVENTS_DB.prepare(`INSERT INTO lifecycle_reviews(id,client_id,client_revision,workspace_id,actor_id,authority_id,revision,resource_id,input_hash,input_json,before_json,after_json,entry_json,affected_json,private_required,auth_identity,auth_fence_json,hook_before_hash,created_at,expires_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
    AND (SELECT count(*) FROM lifecycle_reviews WHERE client_id=? AND state='ready' AND expires_at>?)<?
    AND NOT EXISTS(SELECT 1 FROM lifecycle_reviews WHERE resource_id=? AND state IN ('submitting','indeterminate')) ON CONFLICT(id) DO NOTHING`)
    .bind(input.planId,principal.id,principal.revision,context.workspaceId,context.actorId,state.authorityId,state.revision,entry.resourceId,fingerprint,JSON.stringify(input),JSON.stringify(before),JSON.stringify(after),JSON.stringify(entry),JSON.stringify(affected),privateRequired?1:0,hook?.identity??null,hook?.fence??null,hook?.beforeHash??null,now,expiresAt,now,state.authorityId,state.revision,principal.id,now,CONFIGURATION_LIMITS.PENDING_REVIEWS,entry.resourceId).run()
  const saved=await findLifecycle(env,principal,context,input.planId)
  if(!saved || saved.input_hash!==fingerprint) throw lifecycleConflict()
  return lifecycleResult(env,principal,context,saved)
}
export async function getLifecycle(env:Env,principal:ManagementPrincipal,context:ManagementContext & {planId:string}) {
  authorizeManagement(principal,context.workspaceId)
  let row=await findLifecycle(env,principal,context,context.planId)
  if(!row) throw new ConfigurationError('not_found','Lifecycle review not found')
  if(inputOf(row).change.kind.startsWith('github-') && ['submitting','indeterminate'].includes(row.state)) {
    await reconcileLifecycleHook(env,principal,context,row)
    row=(await findLifecycle(env,principal,context,context.planId))!
  }
  return lifecycleResult(env,principal,context,row)
}
export async function applyLifecycle(env:Env,principal:ManagementPrincipal,context:ManagementContext & {planId:string}) {
  const row=await findLifecycle(env,principal,context,context.planId)
  if(!row) throw new ConfigurationError('not_found','Lifecycle review not found')
  const input=inputOf(row)
  authorizeLifecycle(env,principal,context,input.change)
  const reviewed=await lifecycleResult(env,principal,context,row)
  if(reviewed.state!=='ready') return reviewed
  const state=await readConfigurationState(configurationQuery(env.EVENTS_DB))
  if(state.mode!=='active' || state.authorityId!==row.authority_id || state.revision!==row.revision) throw lifecycleConflict()
  if(row.private_required && !row.private_received) throw new ConfigurationError('conflict','Supply protected destination input before applying')
  if(input.change.kind.startsWith('github-')) {
    await applyLifecycleHook(env,principal,context,row)
    return getLifecycle(env,principal,context)
  }
  const entry=JSON.parse(row.entry_json) as ConfigurationEntry
  if(input.change.kind==='destination-retire') {
    const entries=await readConfigurationEntries(configurationQuery(env.EVENTS_DB))
    const name=entry.key.slice(5)
    const referenced=entries.some(candidate=>{
      if(candidate.namespace!=='SUBS') return false
      const value=JSON.parse(candidate.value) as Record<string,unknown>
      return Array.isArray(value.sinks) && value.sinks.includes(name) && (candidate.key==='config:operations' || Boolean(value.enabled))
    })
    if(referenced) throw new ConfigurationError('conflict','Enabled subscriptions or operational alerts still select this destination; unlink it through routing controls first')
  }
  authorizeLifecycle(env,principal,context,input.change)
  await acceptConfigurationChange(configurationQuery(env.EVENTS_DB),{...owner(principal,{workspaceId:context.workspaceId,actorId:context.actorId}),authorityId:row.authority_id,expectedRevision:row.revision,operationId:row.id,kind:'lifecycle',resourceId:row.resource_id,expiresAt:row.expires_at,puts:[entry],deletes:[]})
  await env.EVENTS_DB.prepare("UPDATE lifecycle_reviews SET state='applied',outcome_json=?,updated_at=? WHERE id=? AND state='ready'").bind(JSON.stringify({configuration:'applied',upstream:'not_requested'}),timestamp(),row.id).run()
  return getLifecycle(env,principal,context)
}
export async function handleLifecycleInput(request:Request,env:Env):Promise<Response> {
  const correlationId=crypto.randomUUID()
  const started=Date.now()
  let custodyCommitted=false
  try {
    const principal=await authenticateManagement(request,env)
    if(request.method!=='POST') throw new ManagementError('method',405,'Use POST')
    const planId=z.uuid().parse(new URL(request.url).pathname.slice(LIFECYCLE_INPUT_PATH.length))
    const context=z.object({workspaceId:z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/),actorId:z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:@-]+$/)}).parse({workspaceId:request.headers.get('X-Workspace-Id'),actorId:request.headers.get('X-Actor-Id')})
    const fingerprint=z.string().regex(/^[a-f0-9]{64}$/).parse(request.headers.get('If-Match'))
    authorizeProvision(principal,context.workspaceId)
    if(!principal.capabilities.includes('custody')) throw new ManagementError('forbidden',403,'Protected input requires custody permission')
    const row=await findLifecycle(env,principal,context,planId)
    if(!row) throw new ConfigurationError('not_found','Lifecycle review not found')
    if(row.input_hash!==fingerprint) throw lifecycleConflict()
    authorizeLifecycle(env,principal,context,inputOf(row).change,true)
    if(row.private_received) return managementResponse({planId,state:row.state,privateInputReceived:true,submitted:false})
    if(row.state!=='ready' || !row.private_required || Date.parse(row.expires_at)<=Date.now()) throw new ConfigurationError('expired','The private input review is unavailable or expired')
    const state=await readConfigurationState(configurationQuery(env.EVENTS_DB))
    if(state.authorityId!==row.authority_id || state.revision!==row.revision || state.mode!=='active') throw lifecycleConflict()
    const occupied=await env.EVENTS_DB.prepare('SELECT plan_id FROM destination_custody WHERE resource_id=? AND revision=?').bind(row.resource_id,row.revision+1).first<{plan_id:string}>()
    if(occupied && occupied.plan_id!==row.id) throw lifecycleConflict()
    const entry=JSON.parse(row.entry_json) as ConfigurationEntry
    const type=JSON.parse(entry.value).type as string
    let privateValue:ReturnType<typeof parseDestinationPrivate>
    try {
      privateValue=parseDestinationPrivate(await readManagementBody(request))
      if(privateValue.type!==type) throw new Error()
    } catch(error) {
      if(error instanceof ManagementError) throw error
      throw new ManagementError('validation',400,'Protected destination input is invalid')
    }
    const encrypted=await sealDestination(env,{authorityId:row.authority_id,workspaceId:row.workspace_id,resourceId:row.resource_id,revision:row.revision+1,type},privateValue)
    authorizeLifecycle(env,principal,context,inputOf(row).change,true)
    const results=await env.EVENTS_DB.batch([
      env.EVENTS_DB.prepare(`INSERT INTO destination_custody(plan_id,resource_id,revision,authority_id,workspace_id,type,encrypted_json,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM lifecycle_reviews r JOIN configuration_authority a ON a.authority_id=r.authority_id AND a.revision=r.revision AND a.mode='active'
          WHERE r.id=? AND r.state='ready' AND r.private_received=0 AND julianday(r.expires_at)>julianday('now')) ON CONFLICT(resource_id,revision) DO NOTHING`)
        .bind(row.id,row.resource_id,row.revision+1,row.authority_id,row.workspace_id,type,JSON.stringify(encrypted),timestamp(),row.id),
      env.EVENTS_DB.prepare(`UPDATE lifecycle_reviews SET private_received=1,updated_at=? WHERE id=? AND state='ready' AND private_received=0
        AND EXISTS(SELECT 1 FROM destination_custody WHERE resource_id=? AND revision=? AND plan_id=?) AND julianday(expires_at)>julianday('now')`)
        .bind(timestamp(),row.id,row.resource_id,row.revision+1,row.id),
    ])
    custodyCommitted=true
    const saved=await findLifecycle(env,principal,context,row.id)
    if(!saved?.private_received) throw lifecycleConflict()
    console.log(JSON.stringify({level:'info',msg:'lifecycle.private.accepted',correlationId,planId,elapsedMs:Date.now()-started}))
    return managementResponse({planId,state:saved.state,privateInputReceived:true,submitted:Boolean(results[1]?.meta.changes)})
  } catch(error) {
    const code=custodyCommitted?'unavailable':error instanceof ConfigurationError || error instanceof ManagementError?error.code:error instanceof z.ZodError?'validation':error instanceof Error && error.message==='Destination input is invalid'?'validation':'unavailable'
    const status=custodyCommitted?503:error instanceof ManagementError?error.status:code==='not_found'?404:code==='conflict'||code==='expired'?409:code==='validation'?400:503
    console.log(JSON.stringify({level:'warn',msg:'lifecycle.private.rejected',correlationId,code,elapsedMs:Date.now()-started}))
    return managementResponse({error:{code,message:'Protected destination input could not complete; retain the review for recovery'},correlationId},status)
  }
}
export async function pruneLifecycleHistory(env:Env) {
  const cutoff=new Date(Date.now()-CONFIGURATION_LIMITS.RECEIPT_DAYS*86400000).toISOString()
  await env.EVENTS_DB.prepare(`DELETE FROM lifecycle_reviews WHERE id IN(SELECT id FROM lifecycle_reviews WHERE expires_at<? AND state IN ('ready','applied','failed','expired') ORDER BY expires_at LIMIT ?)`)
    .bind(cutoff,CONFIGURATION_LIMITS.PRUNE_BATCH).run()
  await env.EVENTS_DB.prepare(`DELETE FROM destination_custody WHERE (resource_id,revision) IN(SELECT c.resource_id,c.revision FROM destination_custody c WHERE c.created_at<?
    AND NOT EXISTS(SELECT 1 FROM configuration_entries e WHERE e.resource_id=c.resource_id AND json_extract(e.value,'$.custody.revision')=c.revision)
    AND NOT EXISTS(SELECT 1 FROM lifecycle_reviews r WHERE r.id=c.plan_id)
    ORDER BY c.created_at LIMIT ?)`)
    .bind(cutoff,CONFIGURATION_LIMITS.PRUNE_BATCH).run()
}
