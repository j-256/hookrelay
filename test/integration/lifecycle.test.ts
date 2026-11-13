import { applyD1Migrations, env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import worker, { type Env } from '../../src/index'
import { acceptConfigurationChange, configurationQuery, readConfigurationState } from '../../src/configuration/authority'
import { managementTokenHash } from '../../src/management/access'
import { subscriptionKvKeyForSlug } from '../../src/lib/subscription'
import { dispatchSink } from '../../src/fanout'
const token = `hkr_${'l'.repeat(43)}`
const secret = 'synthetic-private-destination-value'
const context = { workspaceId: 'workspace', actorId: 'owner' }
const subId = '10000000-0000-4000-8000-000000000001'
const sinkId = '10000000-0000-4000-8000-000000000002'
const slug = 'synthetic-lifecycle-slug-1234567890'
const query = configurationQuery(env.EVENTS_DB)
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
let runtime: Env
let capabilities: string[]
beforeAll(async () => { await applyD1Migrations(env.EVENTS_DB, env.TEST_MIGRATIONS!) })
beforeEach(async () => {
  await env.EVENTS_DB.exec("DELETE FROM github_auth_descriptors; UPDATE github_auth_runtime_policy SET mode='legacy',revision=1; DELETE FROM github_hook_operation_reconciliations; DELETE FROM github_hook_operations; DELETE FROM lifecycle_reviews; DELETE FROM lifecycle_owned_hooks; DELETE FROM destination_custody; DELETE FROM configuration_policy_reviews; DELETE FROM configuration_receipts; DELETE FROM configuration_entries; DELETE FROM deliveries; DELETE FROM events; UPDATE configuration_authority SET revision=0,mode='legacy',operation_id=NULL,pending_change=NULL;")
  capabilities = ['read','configure','provision','custody']
  const credential = { id: 'lifecycle', revision: 1, tokenHash: await managementTokenHash(token), expiresAt: new Date(Date.now()+3600000).toISOString(), workspaceIds: ['workspace'], capabilities }
  runtime = new Proxy(env, { get(target, name, receiver) {
    if (name === 'MANAGEMENT_CREDENTIALS') return JSON.stringify([{ ...credential, capabilities }])
    if (name === 'HOOK_HANDOFF_KEYS') return JSON.stringify({ version: 1, activeKeyId: 'fixture', keys: [{ id: 'fixture', key: btoa('k'.repeat(32)) }] })
    if (name === 'HOOK_SETUP_ORIGIN') return 'https://hooks.example'
    if (name === 'HOOK_SETUP_GITHUB_TOKEN') return 'synthetic-github-token'
    if (name === 'HMAC_SYNTHETIC') return secret
    return Reflect.get(target, name, receiver)
  } })
  const state = await readConfigurationState(query)
  await acceptConfigurationChange(query, { ...context, clientId: 'operator', clientRevision: 1, authorityId: state.authorityId, expectedRevision: 0, kind: 'migration', operationId: crypto.randomUUID(), expiresAt: new Date(Date.now()+60000).toISOString(), deletes: [], puts: [
    { namespace: 'SINKS', key: 'sink:phone', resourceId: sinkId, value: JSON.stringify({ type:'ntfy', topic:'synthetic' }) },
    { namespace: 'SUBS', key: await subscriptionKvKeyForSlug(slug), resourceId: subId, value: JSON.stringify({ name:'example',source:'github',enabled:true,sinks:['phone'],auth:{ scheme:'github-sha256',secretEnv:'HMAC_SYNTHETIC' } }) },
  ] })
})
afterEach(() => vi.restoreAllMocks())
async function call(command: string, input: Record<string,unknown> = {}) {
  return worker.fetch(new Request('https://hooks.example/admin/api/v1', { method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({command,input:{...context,...input}}) }),runtime,ctx)
}
async function result(command: string, input: Record<string,unknown> = {}): Promise<any> {
  const response = await call(command,input)
  const value = await response.json() as any
  expect(value).not.toHaveProperty('error')
  expect(response.status).toBe(200)
  expect(JSON.stringify(value)).not.toContain(secret)
  expect(JSON.stringify(value)).not.toContain(slug)
  return value.result
}
async function plan(change: Record<string,unknown>, extra: Record<string,unknown> = {}) {
  const state = await readConfigurationState(query)
  return result('lifecycle_plan',{...state,mode:undefined,planId:crypto.randomUUID(),change,...extra})
}
function privateRequest(review: any, value: unknown, headers: Record<string,string> = {}) {
  return new Request(`https://hooks.example/admin/api/v1/lifecycle-input/${review.id}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','X-Workspace-Id':context.workspaceId,'X-Actor-Id':context.actorId,'If-Match':review.fingerprint,...headers},body:JSON.stringify(value)})
}
it('creates encrypted destinations with metadata-only repeat input and execution-time resolution', async () => {
  const reviewed = await plan({kind:'destination-create',name:'new-phone',type:'ntfy'})
  expect(reviewed).toMatchObject({state:'ready',privateInputRequired:true,privateInputReceived:false,before:null,after:{name:'new-phone',type:'ntfy'}})
  expect(await worker.fetch(privateRequest(reviewed,{type:'ntfy',topic:secret}),runtime,ctx).then(r=>r.json())).toMatchObject({privateInputReceived:true,submitted:true})
  expect(await worker.fetch(privateRequest(reviewed,{unexpected:'ignored after consumed'}),runtime,ctx).then(r=>r.json())).toMatchObject({privateInputReceived:true,submitted:false})
  expect(await result('lifecycle_apply',{planId:reviewed.id})).toMatchObject({state:'applied',outcome:{configuration:'applied',upstream:'not_requested'}})
  expect(await result('lifecycle_apply',{planId:reviewed.id})).toMatchObject({state:'applied'})
  const stored = await env.EVENTS_DB.prepare('SELECT * FROM destination_custody').all()
  expect(JSON.stringify(stored.results)).not.toContain(secret)
  const fetcher = vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('',{status:200}))
  const delivered = await dispatchSink(runtime,{source:'github',subName:'example',type:'push',id:'fixture',timestamp:new Date().toISOString(),title:'Test',body:'Synthetic',raw:{}},'new-phone')
  expect(delivered).toEqual({ok:true})
  expect(String(fetcher.mock.calls[0]![0])).toContain(secret)
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe('manual')
})
it('rejects foreign actor and missing grants before reading private input, rejects unsafe URLs and expiry', async () => {
  const reviewed = await plan({kind:'destination-create',name:'new-webhook',type:'webhook'})
  expect((await worker.fetch(privateRequest(reviewed,{type:'webhook',url:'https://127.0.0.1/path',signingSecret:secret}),runtime,ctx)).status).toBe(400)
  expect((await worker.fetch(privateRequest(reviewed,{type:'webhook',url:'https://example.test/path',signingSecret:secret},{'X-Actor-Id':'other'}),runtime,ctx)).status).toBe(404)
  capabilities = ['read','provision']
  expect((await worker.fetch(privateRequest(reviewed,{}),runtime,ctx)).status).toBe(403)
  capabilities.push('custody')
  await env.EVENTS_DB.prepare("UPDATE lifecycle_reviews SET expires_at='2000-01-01T00:00:00.000Z'").run()
  expect((await worker.fetch(privateRequest(reviewed,{}),runtime,ctx)).status).toBe(409)
})
it('preserves routes, pending delivery rows, and custody during retirement and restoration', async () => {
  const blocked=await plan({kind:'destination-retire',resourceId:sinkId})
  expect(blocked.affectedSubscriptions).toEqual([{resourceId:subId,name:'example'}])
  expect((await call('lifecycle_apply',{planId:blocked.id})).status).toBe(409)
  const reviewed = await plan({kind:'subscription-retire',resourceId:subId})
  expect(await result('lifecycle_apply',{planId:reviewed.id})).toMatchObject({state:'applied'})
  const saved = await env.EVENTS_DB.prepare('SELECT value,retired FROM configuration_entries WHERE resource_id=?').bind(subId).first<any>()
  expect(saved.retired).toBe(1)
  expect(await result('configuration_subscription',{resourceId:subId})).not.toHaveProperty('retired')
  expect(await result('lifecycle_subscription',{resourceId:subId})).toMatchObject({retired:true})
  expect(JSON.parse(saved.value).enabled).toBe(false)
  const retired = await plan({kind:'destination-retire',resourceId:sinkId})
  expect(await result('lifecycle_apply',{planId:retired.id})).toMatchObject({state:'applied'})
  const restored = await plan({kind:'destination-restore',resourceId:sinkId})
  expect(await result('lifecycle_apply',{planId:restored.id})).toMatchObject({state:'applied'})
  const restoreSub = await plan({kind:'subscription-restore',resourceId:subId})
  expect(await result('lifecycle_apply',{planId:restoreSub.id})).toMatchObject({after:{retired:false},state:'applied'})
  expect(JSON.parse((await env.EVENTS_DB.prepare('SELECT value FROM configuration_entries WHERE resource_id=?').bind(subId).first<any>()).value).enabled).toBe(false)
})
it('serializes competing reviews and refuses duplicate identities, revision drift, and foreign receipts', async () => {
  const first = await plan({kind:'subscription-retire',resourceId:subId})
  const second = await plan({kind:'subscription-retire',resourceId:subId})
  const responses = await Promise.all([call('lifecycle_apply',{planId:first.id}),call('lifecycle_apply',{planId:second.id})])
  expect(responses.filter(r=>r.status===200)).toHaveLength(1)
  expect((await call('lifecycle_get',{planId:first.id,actorId:'other'})).status).toBe(404)
  expect((await call('lifecycle_plan',{planId:first.id,authorityId:first.authorityId,revision:first.revision,change:{kind:'subscription-restore',resourceId:subId}})).status).toBe(409)
})
it('adopts only exact HTTPS receiver ownership and reconciles a lost hook update without resending', async () => {
  let active=true
  let events=['push']
  let lost=false
  let writes=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const path=new URL(String(url)).pathname
    if(path==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(init?.method==='PATCH') {
      writes++
      const value=JSON.parse(String(init.body));active=value.active;events=value.events
      expect(value.config.secret).toBe(secret)
      if(lost) throw new Error('synthetic lost acknowledgment')
    }
    return Response.json({id:42,active,events,config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopted=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  expect(adopted.after).toMatchObject({repository:'owner/repo',hookId:42,signingVerified:false})
  expect(await result('lifecycle_apply',{planId:adopted.id})).toMatchObject({state:'applied'})
  const update=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  lost=true
  const response=await result('lifecycle_apply',{planId:update.id})
  expect(['applied','indeterminate']).toContain(response.state)
  expect(await result('lifecycle_get',{planId:update.id})).toMatchObject({state:'applied'})
  expect(await result('lifecycle_apply',{planId:update.id})).toMatchObject({state:'applied'})
  expect(writes).toBe(1)
  expect((await env.EVENTS_DB.prepare('SELECT state FROM github_hook_operations WHERE operation=\'update\'').first<any>()).state).toBe('indeterminate')
})
it('never lets competing credential reviews consume another review private material', async () => {
  const first=await plan({kind:'destination-update',resourceId:sinkId,replaceCredentials:true})
  const second=await plan({kind:'destination-update',resourceId:sinkId,replaceCredentials:true})
  expect((await worker.fetch(privateRequest(first,{type:'ntfy',topic:secret}),runtime,ctx)).status).toBe(200)
  expect((await worker.fetch(privateRequest(second,{type:'ntfy',topic:'different-synthetic'}),runtime,ctx)).status).toBe(409)
  expect(await result('lifecycle_get',{planId:second.id})).toMatchObject({privateInputReceived:false})
})
it('refuses newly selected retired destinations and reenabling retired subscriptions through ordinary policy', async () => {
  const retired=await plan({kind:'subscription-retire',resourceId:subId})
  await result('lifecycle_apply',{planId:retired.id})
  const state=await readConfigurationState(query)
  expect((await call('configuration_policy_plan',{planId:crypto.randomUUID(),authorityId:state.authorityId,revision:state.revision,resourceId:subId,policy:{enabled:true,sinks:['phone'],filter:null,sinkFilters:{}}})).status).toBe(409)
})
it('returns truthful availability and rejects private input body before reading on a foreign workspace', async () => {
  expect(await result('lifecycle_configuration')).toMatchObject({canProvision:true,canConfigure:true,canSupplyPrivate:true,canManageHooks:true,reason:'ready'})
  capabilities=['read']
  expect(await result('lifecycle_configuration')).toMatchObject({canProvision:false,canConfigure:false,canSupplyPrivate:false,canManageHooks:false,reason:'grant_required'})
})
it('rejects adoption with mismatching receiver origin or route despite matching human names', async () => {
  for(const url of [`https://other.example/hook/github/${slug}`,'https://hooks.example/hook/github/unrelated-synthetic-slug-1234567890']) {
    vi.restoreAllMocks()
    vi.spyOn(globalThis,'fetch').mockImplementation(async(target)=>new URL(String(target)).pathname==='/repos/owner/repo'?Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}}):Response.json({id:42,active:true,events:['push'],config:{url,content_type:'json',insecure_ssl:'0'}}))
    const state=await readConfigurationState(query)
    expect((await call('lifecycle_plan',{planId:crypto.randomUUID(),authorityId:state.authorityId,revision:state.revision,change:{kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42}})).status).toBe(409)
  }
})
it('retains pending deliveries and retired destination ciphertext, then prunes only expired unreferenced custody', async () => {
  const created=await plan({kind:'destination-create',name:'durable-phone',type:'ntfy'})
  await worker.fetch(privateRequest(created,{type:'ntfy',topic:secret}),runtime,ctx)
  await result('lifecycle_apply',{planId:created.id})
  const now=new Date().toISOString()
  await env.EVENTS_DB.prepare("INSERT INTO events(id,received_at,sub_slug,sub_name,source,type,title,r2_key) VALUES('github:pending',?,?,'example','github','push','Synthetic','synthetic')").bind(now,(await subscriptionKvKeyForSlug(slug)).slice('sub:sha256:'.length)).run()
  await env.EVENTS_DB.prepare("INSERT INTO deliveries(event_id,sink_name,status,attempts,generation,created_at,updated_at) VALUES('github:pending','durable-phone','queued',0,1,?,?)").bind(now,now).run()
  const retired=await plan({kind:'destination-retire',resourceId:created.after.resourceId})
  await result('lifecycle_apply',{planId:retired.id})
  expect((await env.EVENTS_DB.prepare("SELECT status FROM deliveries WHERE event_id='github:pending'").first<any>()).status).toBe('queued')
  await env.EVENTS_DB.prepare("UPDATE destination_custody SET created_at='2000-01-01T00:00:00.000Z'").run()
  const {pruneLifecycleHistory}=await import('../../src/management/lifecycle')
  await pruneLifecycleHistory(runtime)
  expect((await env.EVENTS_DB.prepare('SELECT count(*) AS n FROM destination_custody').first<any>()).n).toBe(1)
})
it('pins admitted numeric token authority and refuses a descriptor revision change before apply', async () => {
  const {githubTokenFingerprint}=await import('../../src/lib/github-auth')
  const descriptor={id:'lifecycle-token',revision:1,keyRevision:1,mode:'token',tokenSecretName:'LIFECYCLE_PROVIDER_TOKEN',fingerprint:await githubTokenFingerprint('synthetic-provider-token'),repositories:[{id:12,fullName:'owner/repo',ownerId:13,private:false}],managementWorkspaces:['workspace'],capabilities:['repository-hooks-write'],state:'active'}
  await env.EVENTS_DB.prepare('INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES(?,1,1,?,?)').bind(descriptor.id,JSON.stringify(descriptor),crypto.randomUUID()).run()
  const original=runtime
  runtime=new Proxy(original,{get(target,name,receiver){
    if(name==='GITHUB_AUTH_MODE') return 'token'
    if(name==='GITHUB_AUTH_DESCRIPTOR') return descriptor.id
    if(name==='LIFECYCLE_PROVIDER_TOKEN') return 'synthetic-provider-token'
    return Reflect.get(target,name,receiver)
  }})
  let patches=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(init?.method==='PATCH') patches++
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopted=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopted.id})
  const update=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  const changed={...descriptor,revision:2}
  await env.EVENTS_DB.prepare('UPDATE github_auth_descriptors SET revision=2,metadata_json=? WHERE id=?').bind(JSON.stringify(changed),descriptor.id).run()
  expect((await call('lifecycle_apply',{planId:update.id})).status).toBe(409)
  expect(patches).toBe(0)
})
it('reconciles an uncertain exact deletion using authenticated absence while preserving its journal', async () => {
  let removed=false
  let deletes=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(init?.method==='DELETE') { deletes++;removed=true;throw new Error('synthetic lost deletion acknowledgement') }
    if(removed && new URL(String(url)).pathname.endsWith('/hooks')) return Response.json([])
    if(removed) return Response.json({}, {status:404})
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-delete',resourceId:subId})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'applied',outcome:{upstream:'applied'}})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'applied'})
  expect(deletes).toBe(1)
  expect(await env.EVENTS_DB.prepare('SELECT * FROM lifecycle_owned_hooks WHERE resource_id=?').bind(subId).first()).toBeNull()
  expect(await env.EVENTS_DB.prepare("SELECT observation FROM github_hook_operation_reconciliations WHERE observation='absent'").first()).not.toBeNull()
})
it('does not treat denied reads as absence and blocks another operation on the unresolved target', async () => {
  let denied=false
  let patches=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(denied) return Response.json({}, {status:403})
    if(init?.method==='PATCH') { patches++;denied=true;throw new Error('synthetic unknown update') }
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(await result('lifecycle_get',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(patches).toBe(1)
})
it('requires a correlated authenticated receiver ping before declaring signing verified', async () => {
  let updatedAt=new Date(Date.now()-1000).toISOString()
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>{
    const path=new URL(String(url)).pathname
    if(path==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(path.endsWith('/deliveries')) return Response.json([{guid:'ping-proof',event:'ping',status_code:200,delivered_at:new Date().toISOString()}])
    return Response.json({id:42,active:true,events:['push'],updated_at:updatedAt,config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  expect((await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})).after.signingVerified).toBe(false)
  const body=JSON.stringify({zen:'Synthetic ping'})
  const {hmacSha256Hex}=await import('../../src/lib/hmac')
  const signature=await hmacSha256Hex(secret,new TextEncoder().encode(body))
  const ping=await worker.fetch(new Request(`https://hooks.example/hook/github/${slug}`,{method:'POST',headers:{'content-type':'application/json','x-github-event':'ping','x-github-delivery':'ping-proof','x-hub-signature-256':`sha256=${signature}`},body}),runtime,ctx)
  expect(ping.status).toBe(200)
  expect((await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})).after.signingVerified).toBe(true)
  await new Promise(resolve=>setTimeout(resolve,5))
  updatedAt=new Date().toISOString()
  expect((await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})).after.signingVerified).toBe(false)
})

it('keeps deletion indeterminate when exact hook absence is masked by denied inventory', async () => {
  let removed=false
  let deletes=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    const path=new URL(String(url)).pathname
    if(path==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(init?.method==='DELETE') { deletes++;removed=true;throw new Error('synthetic uncertain delete') }
    if(removed && path.endsWith('/hooks')) return Response.json({}, {status:403})
    if(removed) return Response.json({}, {status:404})
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-delete',resourceId:subId})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(await result('lifecycle_get',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(deletes).toBe(1)
  expect(await env.EVENTS_DB.prepare('SELECT * FROM lifecycle_owned_hooks WHERE resource_id=?').bind(subId).first()).not.toBeNull()
  expect(await env.EVENTS_DB.prepare('SELECT * FROM github_hook_operation_reconciliations').first()).toBeNull()
})

it('rejects foreign workspace hook ownership instead of falsely accepting an unapplied adoption', async () => {
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>new URL(String(url)).pathname==='/repos/owner/repo'?Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}}):Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}}))
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const original=runtime
  runtime=new Proxy(original,{get(target,name,receiver){
    if(name==='MANAGEMENT_CREDENTIALS') return JSON.stringify(JSON.parse(target.MANAGEMENT_CREDENTIALS!).map((value:any)=>({...value,workspaceIds:['workspace','other']})))
    return Reflect.get(target,name,receiver)
  }})
  const state=await readConfigurationState(query)
  expect((await call('lifecycle_plan',{workspaceId:'other',planId:crypto.randomUUID(),authorityId:state.authorityId,revision:state.revision,change:{kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42}})).status).toBe(404)
})
it('rejects native policy import and common authority writes that reenable retired subscriptions', async () => {
  const retired=await plan({kind:'subscription-retire',resourceId:subId})
  await result('lifecycle_apply',{planId:retired.id})
  const {exportConfiguration,reviewConfigurationImport}=await import('../../scripts/configuration-workflow')
  const exported=await exportConfiguration(query)
  const entry=exported.entries.find(value=>value.resourceId===subId)!
  entry.value=JSON.stringify({...JSON.parse(entry.value),enabled:true})
  await expect(reviewConfigurationImport(query,exported)).rejects.toMatchObject({code:'validation'})
  await expect(acceptConfigurationChange(query,{...context,clientId:'operator',clientRevision:1,authorityId:exported.authorityId,expectedRevision:exported.revision,operationId:crypto.randomUUID(),kind:'policy',resourceId:subId,expiresAt:new Date(Date.now()+60000).toISOString(),puts:[entry],deletes:[]})).rejects.toMatchObject({code:'validation'})
})
it('never reports definite rejection after protected custody acceptance commits', async () => {
  const review=await plan({kind:'destination-create',name:'lost-custody-response',type:'ntfy'})
  const original=runtime
  const {ConfigurationError}=await import('../../src/configuration/authority')
  let reads=0
  runtime=new Proxy(original,{get(target,name,receiver){
    if(name==='EVENTS_DB') return new Proxy(target.EVENTS_DB,{get(database,property){
      if(property==='prepare') return (sql:string)=>{
        const statement=database.prepare(sql)
        if(sql==='SELECT * FROM lifecycle_reviews WHERE id=?') return {bind(...params:unknown[]){const bound=statement.bind(...params);return {async first(){reads++;if(reads===2) throw new ConfigurationError('conflict','synthetic lost private acceptance read');return bound.first()}}}}
        return statement
      }
      const value=Reflect.get(database,property)
      return typeof value==='function'?value.bind(database):value
    }})
    return Reflect.get(target,name,receiver)
  }})
  expect((await worker.fetch(privateRequest(review,{type:'ntfy',topic:secret}),runtime,ctx)).status).toBe(503)
  runtime=original
  expect(await result('lifecycle_get',{planId:review.id})).toMatchObject({privateInputReceived:true})
})
it('refuses a native target claim interleaved after the lifecycle claim and before its journal insert', async () => {
  let patches=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(init?.method==='PATCH') patches++
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  const original=runtime
  let injected=false
  runtime=new Proxy(original,{get(target,name,receiver){
    if(name==='EVENTS_DB') return new Proxy(target.EVENTS_DB,{get(database,property){
      if(property==='prepare') return (sql:string)=>{
        const statement=database.prepare(sql)
        if(sql.startsWith('INSERT INTO github_hook_operations')) return {bind(...params:unknown[]){const bound=statement.bind(...params);return {async run(){
          injected=true
          await database.prepare("INSERT INTO github_hook_operations(id,descriptor_id,workspace_id,repository_id,operation,hook_id,request_hash,target_hash,auth_fence_json,state,created_at,updated_at) VALUES (?,'native-credential','workspace',12,'delete',42,?,?,'{}','prepared',?,?)").bind(crypto.randomUUID(),'a'.repeat(64),'b'.repeat(64),Date.now(),Date.now()).run()
          return bound.run()
        }}}}
        return statement
      }
      const value=Reflect.get(database,property)
      return typeof value==='function'?value.bind(database):value
    }})
    return Reflect.get(target,name,receiver)
  }})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'failed'})
  expect(injected).toBe(true)
  expect(patches).toBe(0)
})
it('uses indexed repository target guards across credential descriptors', async () => {
  for(const [predicate,params] of [['hook_id=?',[42]],['target_hash=?',['a'.repeat(64)]]] as const) {
    const plan=await env.EVENTS_DB.prepare(`EXPLAIN QUERY PLAN SELECT id FROM github_hook_operations WHERE repository_id=? AND ${predicate} AND state IN ('prepared','submitting','indeterminate')`).bind(12,...params).all()
    expect(JSON.stringify(plan.results)).toContain('github_hook_operations_repository_')
  }
})
it('does not report applied when an ownership insert has no effect', async () => {
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>new URL(String(url)).pathname==='/repos/owner/repo'?Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}}):Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}}))
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await env.EVENTS_DB.exec('CREATE TRIGGER lifecycle_test_ignore_ownership BEFORE INSERT ON lifecycle_owned_hooks BEGIN SELECT RAISE(IGNORE); END;')
  try {
    expect(await result('lifecycle_apply',{planId:adopt.id})).toMatchObject({state:'failed'})
    expect(await env.EVENTS_DB.prepare('SELECT * FROM lifecycle_owned_hooks').first()).toBeNull()
  } finally {await env.EVENTS_DB.exec('DROP TRIGGER lifecycle_test_ignore_ownership;')}
})
it('preserves accepted provider acknowledgement when authority is withdrawn during the response', async () => {
  const {githubTokenFingerprint}=await import('../../src/lib/github-auth')
  const descriptor={id:'withdrawn-lifecycle-token',revision:1,keyRevision:1,mode:'token',tokenSecretName:'LIFECYCLE_ACK_TOKEN',fingerprint:await githubTokenFingerprint('synthetic-ack-provider-token'),repositories:[{id:12,fullName:'owner/repo',ownerId:13,private:false}],managementWorkspaces:['workspace'],capabilities:['repository-hooks-write'],state:'active'}
  await env.EVENTS_DB.prepare('INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES(?,1,1,?,?)').bind(descriptor.id,JSON.stringify(descriptor),crypto.randomUUID()).run()
  await env.EVENTS_DB.prepare("UPDATE github_auth_runtime_policy SET mode='registry',revision=revision+1").run()
  const original=runtime
  runtime=new Proxy(original,{get(target,name,receiver){if(name==='LIFECYCLE_ACK_TOKEN') return 'synthetic-ack-provider-token';return Reflect.get(target,name,receiver)}})
  let patches=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(init?.method==='PATCH') {
      patches++
      const updated=JSON.parse(String(init.body))
      await env.EVENTS_DB.prepare('DELETE FROM github_auth_descriptors WHERE id=?').bind(descriptor.id).run()
      return Response.json({id:42,...updated})
    }
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'indeterminate'})
  expect(await env.EVENTS_DB.prepare("SELECT state,verified FROM github_hook_operations WHERE operation='update'").first()).toMatchObject({state:'accepted',verified:0})
  expect(patches).toBe(1)
})
it('records an explicit provider rejection as failed without replaying it', async () => {
  let patches=0
  vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
    if(new URL(String(url)).pathname==='/repos/owner/repo') return Response.json({id:12,full_name:'owner/repo',private:false,owner:{id:13}})
    if(init?.method==='PATCH') {patches++;return Response.json({}, {status:403})}
    return Response.json({id:42,active:true,events:['push'],config:{url:`https://hooks.example/hook/github/${slug}`,content_type:'json',insecure_ssl:'0'}})
  })
  const adopt=await plan({kind:'github-hook-adopt',resourceId:subId,repository:'owner/repo',hookId:42})
  await result('lifecycle_apply',{planId:adopt.id})
  const review=await plan({kind:'github-hook-update',resourceId:subId,events:['issues'],active:false})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'failed'})
  expect(await result('lifecycle_apply',{planId:review.id})).toMatchObject({state:'failed'})
  expect(await env.EVENTS_DB.prepare("SELECT state,provider_status FROM github_hook_operations WHERE operation='update'").first()).toMatchObject({state:'rejected',provider_status:403})
  expect(patches).toBe(1)
})
it('bounds retirement impact by enabled references before the sort and page boundary', async () => {
  await env.EVENTS_DB.prepare("UPDATE configuration_entries SET value=json_set(value,'$.enabled',json('false')) WHERE resource_id=?").bind(subId).run()
  const disabledReferences=Array.from({length:26},(_,index)=>({
    namespace:'SUBS',
    key:`sub:sha256:${(index+100).toString(16).padStart(64,'0')}`,
    resourceId:`20000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,
    value:JSON.stringify({name:`disabled-reference-${index}`,source:'github',enabled:false,sinks:['phone'],auth:null}),
  }))
  await env.EVENTS_DB.batch(disabledReferences.map(entry=>env.EVENTS_DB.prepare('INSERT INTO configuration_entries(namespace,entry_key,resource_id,retired,value) VALUES(?,?,?,0,?)').bind(entry.namespace,entry.key,entry.resourceId,entry.value)))
  const unreferenced=await plan({kind:'destination-retire',resourceId:sinkId})
  expect(unreferenced.affectedSubscriptions).toEqual([])
  const lateResourceId='f0000000-0000-4000-8000-000000000001'
  await env.EVENTS_DB.prepare('INSERT INTO configuration_entries(namespace,entry_key,resource_id,retired,value) VALUES(?,?,?,0,?)').bind('SUBS',`sub:sha256:${'f'.repeat(64)}`,lateResourceId,JSON.stringify({name:'enabled-after-disabled-boundary',source:'github',enabled:true,sinks:['phone'],auth:null})).run()
  const blocked=await plan({kind:'destination-retire',resourceId:sinkId})
  expect(blocked.affectedSubscriptions).toEqual([{resourceId:lateResourceId,name:'enabled-after-disabled-boundary'}])
  expect((await call('lifecycle_apply',{planId:blocked.id})).status).toBe(409)
  await env.EVENTS_DB.prepare("UPDATE configuration_entries SET value=json_set(value,'$.enabled',json('true')) WHERE resource_id LIKE '20000000-%'").run()
  const state=await readConfigurationState(query)
  expect((await call('lifecycle_plan',{...state,mode:undefined,planId:crypto.randomUUID(),change:{kind:'destination-retire',resourceId:sinkId}})).status).toBe(400)
})
