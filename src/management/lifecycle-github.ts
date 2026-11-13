import { z } from 'zod'
import type { Env } from '../index'
import type { Subscription } from '../types'
import { ConfigurationError, configurationDigest, configurationQuery, readConfigurationState, type ConfigurationEntry } from '../configuration/authority'
import { githubAuthFencePredicate } from '../configuration/github-auth'
import { GitHubAuthError, GITHUB_APP_LIMITS } from '../lib/github-app-contract'
import { readGitHubAppJson } from '../lib/github-app-token'
import { githubRetryAt } from '../lib/github-rate-limit'
import { fetchGitHubWithDeadline } from '../lib/github-http'
import { canonicalReceiverTarget, githubRepositoryHookSchema, GITHUB_HOOK_LIMITS } from '../lib/github-hook-protocol'
import { hashSubscriptionSlug } from '../lib/subscription'
import { deriveGitHubSetupSecret } from '../lib/github-setup'
import { readHandoffSigningSecret } from '../lib/github-handoff-store'
import { readSecret } from '../lib/secret'
import { assertCurrentManagementGrant, authorizeProvision, type ManagementPrincipal } from './access'
import { createRuntimeGitHubAuthentication, type RuntimeGitHubAuthentication } from './github-auth'
import type { ManagementContext } from './contract'
import { lifecycleInputs, type LifecycleInput } from './lifecycle-contract'
import type { LifecycleRow } from './lifecycle'
const conflict=()=>new ConfigurationError('conflict','Owned hook or authority changed; retain the original review and review again')
const timestamp=()=>new Date().toISOString()
const HOOK_TIMESTAMP_PRECISION_MS=1000
const requestDeadlines=new WeakMap<RuntimeGitHubAuthentication,AbortSignal>()
type Hook=z.infer<typeof githubRepositoryHookSchema>
type Owned={resource_id:string;workspace_id:string;repository:string;repository_id:number;hook_id:number;target_hash:string;events_json:string;active:number;signing_verified:number}
async function owned(env:Env,resourceId:string,workspaceId:string) {
  const row=await env.EVENTS_DB.prepare('SELECT * FROM lifecycle_owned_hooks WHERE resource_id=?').bind(resourceId).first<Owned>()
  if(row && row.workspace_id!==workspaceId) throw new ConfigurationError('not_found','Owned hook not found')
  return row
}
function guard(auth:RuntimeGitHubAuthentication) { return auth.initial?githubAuthFencePredicate(auth.initial.fence):{sql:'1=1',params:[] as (string|number|null)[]} }
async function authIdentity(env:Env,auth:RuntimeGitHubAuthentication) {
  return auth.identity??configurationDigest({legacyToken:env.HOOK_SETUP_GITHUB_TOKEN,origin:env.HOOK_SETUP_ORIGIN})
}
async function request(auth:RuntimeGitHubAuthentication,repository:string,suffix:string,method='GET',body?:unknown,onDispatch?:()=>void,allowAbsent=false,beforeEffect?:()=>Promise<void>,onResponse?:(status:number)=>Promise<void>) {
  let signal=requestDeadlines.get(auth)
  if(!signal) {signal=AbortSignal.timeout(GITHUB_APP_LIMITS.REQUEST_MS);requestDeadlines.set(auth,signal)}
  for(let attempt=0;attempt<2;attempt++) {
    const credential=await auth.resolve(method==='GET'?'read':'effect',signal,attempt>0)
    if(method!=='GET') await beforeEffect?.()
    const response=await fetchGitHubWithDeadline(fetch,`https://api.github.com/repos/${repository}${suffix}`,{method,redirect:'manual',signal,headers:{authorization:`Bearer ${credential.token}`,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'Hookrelay',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},onDispatch)
    if(method!=='GET') await onResponse?.(response.status)
    await auth.recordResponse(response)
    if(response.status===401 && auth.renewable && attempt===0) { void response.body?.cancel().catch(()=>{});continue }
    const retryAt=githubRetryAt(response)
    if(retryAt!==null) { void response.body?.cancel().catch(()=>{});throw new GitHubAuthError('rate_limited',retryAt) }
    if(allowAbsent && response.status===404) { void response.body?.cancel().catch(()=>{});await auth.assert();return null }
    if(response.status!==(method==='DELETE'||suffix.endsWith('/pings')?204:200)) {
      void response.body?.cancel().catch(()=>{})
      throw new GitHubAuthError([400,401,403,404,422].includes(response.status)?'denied':'unavailable')
    }
    const result=method==='DELETE'||suffix.endsWith('/pings')?null:await readGitHubAppJson(response,signal)
    if(result===null) void response.body?.cancel().catch(()=>{})
    await auth.assert()
    return result
  }
  throw new GitHubAuthError('unavailable')
}
async function repository(auth:RuntimeGitHubAuthentication,name:string) {
  const observed=z.object({id:z.number().int().positive().safe(),full_name:z.string(),owner:z.object({id:z.number().int().positive().safe()}),private:z.boolean()}).parse(await request(auth,name,''))
  if(observed.full_name!==name || (auth.initial && observed.id!==auth.initial.fence.repositoryId)) throw new GitHubAuthError('denied')
  return observed.id
}
async function verifyReceiver(env:Env,entry:ConfigurationEntry,hook:Hook) {
  const sub=JSON.parse(entry.value) as Subscription
  let origin:URL
  let receiver:URL
  try { origin=new URL(env.HOOK_SETUP_ORIGIN??'');receiver=new URL(hook.config.url) } catch { throw conflict() }
  if(sub.source!=='github'||sub.auth?.scheme!=='github-sha256'||origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||receiver.origin!==origin.origin||receiver.username||receiver.password||receiver.search||receiver.hash||hook.config.content_type!=='json'||String(hook.config.insecure_ssl)!=='0') throw conflict()
  const route=/^\/hook\/github\/([A-Za-z0-9_-]{22,128})\/?$/.exec(receiver.pathname)
  if(!route || entry.key!==`sub:sha256:${await hashSubscriptionSlug(route[1]!)}`) throw conflict()
  return {sub,targetHash:await configurationDigest(canonicalReceiverTarget(hook.config.url))}
}
async function signingSecret(env:Env,sub:Subscription,entry:ConfigurationEntry) {
  if(!sub.auth) throw conflict()
  if(sub.auth.credentialId) return readHandoffSigningSecret(env,sub)
  if(sub.auth.derivationId) {
    const key=readSecret(env,sub.auth.secretEnv)
    if(sub.auth.derivationId!==entry.resourceId || !sub.githubSetup || sub.githubSetup.resourceId!==entry.resourceId || sub.githubSetup.keyDigest!==await configurationDigest(key) || entry.key!==`sub:sha256:${await hashSubscriptionSlug(await deriveGitHubSetupSecret(key,entry.resourceId,'route'))}`) throw conflict()
    return deriveGitHubSetupSecret(key,sub.auth.derivationId,'signature')
  }
  return readSecret(env,sub.auth.secretEnv)
}
function summary(entry:ConfigurationEntry,name:string,hook:Hook,verified=false) {
  return {resourceId:entry.resourceId,name:JSON.parse(entry.value).name as string,retired:Boolean(entry.retired),repository:name,hookId:hook.id,events:hook.events,active:hook.active,signingVerified:verified}
}
async function signingEvidence(env:Env,entry:ConfigurationEntry,repositoryName:string,hook:Hook,auth:RuntimeGitHubAuthentication) {
  // Correlated signing evidence must follow the observed hook configuration generation
  try {
    if(!hook.updated_at) return false
    const updatedAt=Date.parse(hook.updated_at)
    const now=Date.now()
    if(updatedAt>now) return false
    const deliveries=z.array(z.object({guid:z.string().max(240),event:z.string().max(80),status_code:z.number().nullable(),delivered_at:z.iso.datetime({offset:true}).nullable()})).max(GITHUB_HOOK_LIMITS.PAGE_SIZE).parse(await request(auth,repositoryName,`/hooks/${hook.id}/deliveries?per_page=${GITHUB_HOOK_LIMITS.PAGE_SIZE}`))
    const pings=deliveries.filter(row=>row.event==='ping' && row.status_code!==null && row.status_code>=200 && row.status_code<300 && row.delivered_at!==null && Date.parse(row.delivered_at)>=updatedAt+HOOK_TIMESTAMP_PRECISION_MS && Date.parse(row.delivered_at)<=Date.now() && Date.now()-Date.parse(row.delivered_at)<=GITHUB_APP_LIMITS.AUTHORITY_AGE_MS).map(row=>`github:${row.guid}`)
    if(!pings.length) return false
    const observed=await env.EVENTS_DB.prepare("SELECT received_at FROM events WHERE id IN(SELECT value FROM json_each(?)) AND sub_slug=? AND source='github' AND type='ping.event' AND received_at>=? ORDER BY received_at DESC LIMIT 1").bind(JSON.stringify(pings),entry.key.slice('sub:sha256:'.length),new Date(updatedAt+HOOK_TIMESTAMP_PRECISION_MS).toISOString()).first<{received_at:string}>()
    if(!observed || Date.now()-Date.parse(observed.received_at)>GITHUB_APP_LIMITS.AUTHORITY_AGE_MS) return false
    const current=githubRepositoryHookSchema.parse(await request(auth,repositoryName,`/hooks/${hook.id}`))
    return await configurationDigest(current)===await configurationDigest(hook)
  } catch { return false }
}

export async function planLifecycleHook(env:Env,principal:ManagementPrincipal,context:ManagementContext,change:LifecycleInput['change'],entry:ConfigurationEntry) {
  if(!change.kind.startsWith('github-')) throw conflict()
  const binding=await owned(env,entry.resourceId,context.workspaceId)
  const name=change.kind==='github-hook-adopt'?change.repository:binding?.repository
  const hookId=change.kind==='github-hook-adopt'?change.hookId:binding?.hook_id
  if(!name || !hookId) throw new ConfigurationError('conflict','Adopt this exact upstream hook before changing or deleting it')
  if(change.kind==='github-hook-adopt' && binding) throw new ConfigurationError('conflict','This subscription already owns an upstream hook')
  const auth=await createRuntimeGitHubAuthentication(env,principal,context,name)
  const repositoryId=await repository(auth,name)
  const hook=githubRepositoryHookSchema.parse(await request(auth,name,`/hooks/${hookId}`))
  if(hook.id!==hookId || (binding && repositoryId!==binding.repository_id)) throw conflict()
  const verified=await verifyReceiver(env,entry,hook)
  if(binding && binding.target_hash!==verified.targetHash) throw conflict()
  if(change.kind==='github-hook-update') await signingSecret(env,verified.sub,entry)
  const before=change.kind==='github-hook-adopt'?{resourceId:entry.resourceId,name:verified.sub.name,retired:Boolean(entry.retired)}:summary(entry,name,hook,Boolean(binding?.signing_verified))
  const after=change.kind==='github-hook-delete'?{resourceId:entry.resourceId,name:verified.sub.name,retired:Boolean(entry.retired)}:summary(entry,name,change.kind==='github-hook-update'?{...hook,events:change.events,active:change.active}:hook,await signingEvidence(env,entry,name,hook,auth))
  const identity=await authIdentity(env,auth)
  const fence=JSON.stringify(auth.initial?.fence??{repositoryId,repositoryFullName:name,legacy:true})
  return {before,after,auth:{identity,fence,beforeHash:await configurationDigest({hook,repositoryId,targetHash:verified.targetHash,binding})}}
}
async function savedDetails(env:Env,principal:ManagementPrincipal,context:ManagementContext,row:LifecycleRow) {
  const input=lifecycleInputs.lifecycle_plan.parse(JSON.parse(row.input_json))
  const change=input.change
  const original=JSON.parse(row.entry_json) as ConfigurationEntry
  const entry=await env.EVENTS_DB.prepare("SELECT namespace,entry_key AS key,resource_id AS resourceId,retired,value FROM configuration_entries WHERE resource_id=? AND namespace='SUBS'").bind(row.resource_id).first<ConfigurationEntry>()
  if(!entry || entry.value!==original.value || entry.key!==original.key || Boolean(entry.retired)!==Boolean(original.retired)) throw conflict()
  const binding=await owned(env,row.resource_id,context.workspaceId)
  const name=change.kind==='github-hook-adopt'?change.repository:binding?.repository??JSON.parse(row.before_json).repository as string|undefined
  const hookId=change.kind==='github-hook-adopt'?change.hookId:binding?.hook_id??JSON.parse(row.before_json).hookId as number|undefined
  if(!name||!hookId) throw conflict()
  const auth=await createRuntimeGitHubAuthentication(env,principal,context,name)
  const repositoryId=await repository(auth,name)
  if(await authIdentity(env,auth)!==row.auth_identity || JSON.stringify(auth.initial?.fence??{repositoryId,repositoryFullName:name,legacy:true})!==row.auth_fence_json) throw conflict()
  return {input,change,entry,binding,name,hookId,auth,repositoryId}
}
async function persistOwnership(env:Env,row:LifecycleRow,details:Awaited<ReturnType<typeof savedDetails>>,hook:Hook|null) {
  const change=details.change
  const after=JSON.parse(row.after_json)
  const guardValue=guard(details.auth)
  await details.auth.assert()
  const statements: D1PreparedStatement[]=[]
  let persistedSql='NOT EXISTS(SELECT 1 FROM lifecycle_owned_hooks WHERE resource_id=?)'
  let persistedParams:(string|number|null)[]=[row.resource_id]
  if(change.kind==='github-hook-delete') statements.push(env.EVENTS_DB.prepare(`DELETE FROM lifecycle_owned_hooks WHERE resource_id=? AND workspace_id=? AND repository_id=? AND hook_id=? AND (${guardValue.sql})`).bind(row.resource_id,row.workspace_id,details.repositoryId,details.hookId,...guardValue.params))
  else if(hook) {
    const verified=await verifyReceiver(env,details.entry,hook)
    persistedSql='EXISTS(SELECT 1 FROM lifecycle_owned_hooks WHERE resource_id=? AND workspace_id=? AND repository_id=? AND hook_id=? AND target_hash=? AND events_json=? AND active=? AND signing_verified=?)'
    persistedParams=[row.resource_id,row.workspace_id,details.repositoryId,hook.id,verified.targetHash,JSON.stringify(hook.events),hook.active?1:0,after.signingVerified?1:0]
    statements.push(env.EVENTS_DB.prepare(`INSERT INTO lifecycle_owned_hooks(resource_id,workspace_id,repository,repository_id,hook_id,target_hash,events_json,active,signing_verified,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE (${guardValue.sql}) ON CONFLICT(resource_id) DO UPDATE SET events_json=excluded.events_json,active=excluded.active,signing_verified=excluded.signing_verified,updated_at=excluded.updated_at WHERE lifecycle_owned_hooks.workspace_id=excluded.workspace_id AND lifecycle_owned_hooks.repository_id=excluded.repository_id AND lifecycle_owned_hooks.hook_id=excluded.hook_id AND lifecycle_owned_hooks.target_hash=excluded.target_hash`)
      .bind(row.resource_id,row.workspace_id,details.name,details.repositoryId,hook.id,verified.targetHash,JSON.stringify(hook.events),hook.active?1:0,after.signingVerified?1:0,timestamp(),...guardValue.params))
  }
  statements.push(env.EVENTS_DB.prepare(`UPDATE lifecycle_reviews SET state='applied',outcome_json=?,error_code=NULL,updated_at=? WHERE id=? AND state IN ('submitting','indeterminate') AND (${guardValue.sql}) AND (${persistedSql})`).bind(JSON.stringify({configuration:'applied',upstream:change.kind==='github-hook-adopt'?'unchanged':'applied'}),timestamp(),row.id,...guardValue.params,...persistedParams))
  const result=await env.EVENTS_DB.batch(statements)
  if(!result.at(-1)?.meta.changes) throw new GitHubAuthError('indeterminate')
}
export async function applyLifecycleHook(env:Env,principal:ManagementPrincipal,context:ManagementContext,row:LifecycleRow) {
  const started=Date.now()
  const details=await savedDetails(env,principal,context,row)
  const hook=githubRepositoryHookSchema.parse(await request(details.auth,details.name,`/hooks/${details.hookId}`))
  const verified=await verifyReceiver(env,details.entry,hook)
  if(await configurationDigest({hook,repositoryId:details.repositoryId,targetHash:verified.targetHash,binding:details.binding})!==row.hook_before_hash) throw conflict()
  const authGuard=guard(details.auth)
  const idTarget=await configurationDigest({repositoryId:details.repositoryId,target:details.hookId})
  const urlTarget=await configurationDigest({repositoryId:details.repositoryId,target:canonicalReceiverTarget(hook.config.url)})
  const operationId=crypto.randomUUID()
  const operation=details.change.kind==='github-hook-delete'?'delete':details.change.kind==='github-hook-update'?'update':'ping'
  const requestHash=await configurationDigest({change:details.change,resourceId:row.resource_id,hookHash:row.hook_before_hash})
  const descriptor=details.auth.initial?.fence.descriptorId??'legacy-runtime'
  const claim=await env.EVENTS_DB.prepare(`UPDATE lifecycle_reviews SET state='submitting',hook_operation_id=?,updated_at=? WHERE id=? AND state='ready' AND julianday(expires_at)>julianday('now')
    AND EXISTS(SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active')
    AND NOT EXISTS(SELECT 1 FROM lifecycle_reviews r WHERE r.resource_id=? AND r.id<>? AND r.state IN ('submitting','indeterminate'))
    AND NOT EXISTS(SELECT 1 FROM github_setup_reviews s WHERE s.resource_id=? AND s.state IN ('installing','indeterminate'))
    AND NOT EXISTS(SELECT 1 FROM github_hook_operations o WHERE o.repository_id=? AND (o.target_hash IN (?,?) OR o.hook_id=?) AND o.state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=o.id))
    AND (${authGuard.sql}) RETURNING id`)
    .bind(operationId,timestamp(),row.id,row.authority_id,row.revision,row.resource_id,row.id,row.resource_id,details.repositoryId,idTarget,urlTarget,details.hookId,...authGuard.params).first()
  if(!claim) throw conflict()
  let dispatched=false
  let acknowledged=false
  let rejected=false
  let providerStatus:number|null=null
  let journaled=false
  try {
    if(details.change.kind==='github-hook-adopt') {
      await persistOwnership(env,row,details,hook)
      return
    }
    await env.EVENTS_DB.prepare(`INSERT INTO github_hook_operations(id,descriptor_id,workspace_id,repository_id,operation,hook_id,request_hash,target_hash,auth_fence_json,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,'prepared',?,? WHERE (SELECT count(*) FROM github_hook_operations WHERE descriptor_id=? AND state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id))<?
      AND NOT EXISTS(SELECT 1 FROM github_hook_operations o WHERE o.repository_id=? AND (o.target_hash IN (?,?) OR o.hook_id=?) AND o.state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=o.id))
      AND (${authGuard.sql})`)
      .bind(operationId,descriptor,row.workspace_id,details.repositoryId,operation,details.hookId,requestHash,operation==='delete'?idTarget:urlTarget,row.auth_fence_json!,Date.now(),Date.now(),descriptor,GITHUB_HOOK_LIMITS.PENDING,details.repositoryId,idTarget,urlTarget,details.hookId,...authGuard.params).run()
    const journal=await env.EVENTS_DB.prepare('SELECT id FROM github_hook_operations WHERE id=?').bind(operationId).first()
    if(!journal) throw new GitHubAuthError('unavailable')
    journaled=true
    assertCurrentManagementGrant(env,principal,context.workspaceId)
    authorizeProvision(principal,context.workspaceId)
    await details.auth.assert()
    const submitting=await env.EVENTS_DB.prepare(`UPDATE github_hook_operations SET state='submitting',updated_at=? WHERE id=? AND state='prepared' AND EXISTS(SELECT 1 FROM configuration_authority WHERE authority_id=? AND revision=? AND mode='active') AND (${authGuard.sql}) RETURNING id`).bind(Date.now(),operationId,row.authority_id,row.revision,...authGuard.params).first()
    if(!submitting) throw conflict()
    const updated=details.change.kind==='github-hook-delete'?null:{active:details.change.kind==='github-hook-update'?details.change.active:hook.active,events:details.change.kind==='github-hook-update'?details.change.events:hook.events,config:{...hook.config,secret:await signingSecret(env,verified.sub,details.entry)}}
    const response=await request(details.auth,details.name,`/hooks/${details.hookId}`,details.change.kind==='github-hook-delete'?'DELETE':'PATCH',updated??undefined,()=>{dispatched=true;rejected=false},false,async()=>{
      assertCurrentManagementGrant(env,principal,context.workspaceId)
      const observedState=await readConfigurationState(configurationQuery(env.EVENTS_DB))
      if(observedState.authorityId!==row.authority_id || observedState.revision!==row.revision || observedState.mode!=='active' || Date.parse(row.expires_at)<=Date.now()) throw conflict()
    },async status=>{
      providerStatus=status
      rejected=[400,401,403,404,422,429].includes(status)
      if(status===(operation==='delete'?204:200)) {
        acknowledged=true
        await env.EVENTS_DB.prepare("UPDATE github_hook_operations SET state='accepted',verified=0,provider_status=?,error_code='acknowledged_unverified',updated_at=? WHERE id=? AND state='submitting'").bind(status,Date.now(),operationId).run()
      }
    })
    const observed=response===null?null:githubRepositoryHookSchema.parse(response)
    if(observed && (observed.id!==hook.id || observed.config.url!==hook.config.url || observed.active!==updated!.active || JSON.stringify([...observed.events].sort())!==JSON.stringify([...updated!.events].sort()))) throw new GitHubAuthError('indeterminate')
    await env.EVENTS_DB.prepare(`UPDATE github_hook_operations SET state='accepted',verified=1,provider_status=?,error_code=NULL,updated_at=? WHERE id=? AND state IN ('submitting','accepted') AND (${authGuard.sql})`).bind(operation==='delete'?204:200,Date.now(),operationId,...authGuard.params).run()
    await persistOwnership(env,row,details,observed)
  } catch {
    const uncertain=acknowledged || (dispatched && !rejected)
    const code=uncertain?'github_indeterminate':'github_rejected'
    if(journaled) await env.EVENTS_DB.prepare("UPDATE github_hook_operations SET state=?,provider_status=?,error_code=?,updated_at=? WHERE id=? AND state IN ('prepared','submitting')").bind(uncertain?'indeterminate':'rejected',providerStatus,code,Date.now(),operationId).run()
    await env.EVENTS_DB.prepare("UPDATE lifecycle_reviews SET state=?,error_code=?,outcome_json=?,updated_at=? WHERE id=? AND state='submitting'").bind(uncertain?'indeterminate':'failed',code,JSON.stringify({configuration:'unchanged',upstream:uncertain?'indeterminate':'failed',errorCode:code}),timestamp(),row.id).run()
    console.log(JSON.stringify({level:'warn',msg:'lifecycle.github.outcome',correlationId:row.id,code,operation,acknowledged,providerStatus,elapsedMs:Date.now()-started}))
  }
}
export async function reconcileLifecycleHook(env:Env,principal:ManagementPrincipal,context:ManagementContext,row:LifecycleRow) {
  try {
    assertCurrentManagementGrant(env,principal,context.workspaceId)
    const details=await savedDetails(env,principal,context,row)
    const state=await readConfigurationState(configurationQuery(env.EVENTS_DB))
    if(state.authorityId!==row.authority_id || state.mode!=='active') return
    const value=await request(details.auth,details.name,`/hooks/${details.hookId}`,'GET',undefined,undefined,details.change.kind==='github-hook-delete')
    const hook=value===null?null:githubRepositoryHookSchema.parse(value)
    if(value===null && details.change.kind==='github-hook-delete') {
      let complete=false
      for(let page=1;page<=GITHUB_HOOK_LIMITS.PAGES;page++) {
        const hooks=z.array(githubRepositoryHookSchema).max(GITHUB_HOOK_LIMITS.PAGE_SIZE).parse(await request(details.auth,details.name,`/hooks?per_page=${GITHUB_HOOK_LIMITS.PAGE_SIZE}&page=${page}`))
        if(hooks.some(candidate=>candidate.id===details.hookId)) return
        if(hooks.length<GITHUB_HOOK_LIMITS.PAGE_SIZE) {complete=true;break}
      }
      if(!complete) return
    }
    const after=JSON.parse(row.after_json)
    if(details.change.kind==='github-hook-delete'?hook!==null:!hook||hook.id!==details.hookId||hook.active!==after.active||JSON.stringify([...hook.events].sort())!==JSON.stringify([...after.events].sort())) return
    if(hook) await verifyReceiver(env,details.entry,hook)
    if(row.hook_operation_id) {
      await env.EVENTS_DB.prepare(`INSERT INTO github_hook_operation_reconciliations(operation_id,observation,hook_id,proof_json,auth_fence_json,observed_at,reconciled_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM github_hook_operations WHERE id=? AND state IN ('submitting','indeterminate','accepted')) ON CONFLICT(operation_id) DO NOTHING`)
        .bind(row.hook_operation_id,hook?'present':'absent',hook?.id??details.hookId,JSON.stringify({resourceId:row.resource_id,repositoryId:details.repositoryId,hookId:details.hookId,active:hook?.active??null,events:hook?.events??null}),row.auth_fence_json!,Date.now(),Date.now(),row.hook_operation_id).run()
    }
    await persistOwnership(env,row,details,hook)
  } catch {
    // Reconciliation reads never resend an uncertain provider write
  }
}
