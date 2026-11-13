import { expect,it } from 'vitest'
import type { Env } from '../../src/index'
import { sealDestination } from '../../src/lib/destination-custody'
import { openProtectedValue } from '../../src/lib/github-handoff-crypto'
const env={HOOK_HANDOFF_KEYS:JSON.stringify({version:1,activeKeyId:'fixture',keys:[{id:'fixture',key:btoa('x'.repeat(32))}]})} as Env
const binding={authorityId:'a'.repeat(32),workspaceId:'workspace',resourceId:'10000000-0000-4000-8000-000000000001',revision:1,type:'ntfy'}
it('authenticates destination purpose, resource, revision, workspace, authority, and type independently of handoff custody',async()=>{
  const sealed=await sealDestination(env,binding,{type:'ntfy',topic:'synthetic-private-topic'})
  expect(await openProtectedValue(env,'hookrelay.destination.v1',binding,sealed)).toMatchObject({type:'ntfy'})
  for(const changed of [{...binding,resourceId:crypto.randomUUID()},{...binding,revision:2},{...binding,workspaceId:'another'},{...binding,authorityId:'b'.repeat(32)},{...binding,type:'discord'}]) await expect(openProtectedValue(env,'hookrelay.destination.v1',changed,sealed)).rejects.toThrow()
  await expect(openProtectedValue(env,'hookrelay.github-handoff.v1',binding,sealed)).rejects.toThrow()
})
