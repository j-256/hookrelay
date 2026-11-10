import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import {authenticatedGitHubFleetDependencies} from '../../integrations/github-fleet/src/fleet.ts'
import {authenticatedGitHubFleetRetirementDependencies} from '../../integrations/github-fleet/src/retirement.ts'

for(const mode of ['app','token'])test(`${mode} fleet factories pass admitted scope to real mixed-root discovery`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'hookrelay-scoped-factories-'))
  try {
    for(const child of ['allowed','unrelated']) {
      const path=join(root,child);await mkdir(path)
      execFileSync('git',['init','--quiet',path])
      execFileSync('git',['-C',path,'remote','add','origin','https://github.com/owner/'+child+'.git'])
    }
    const reads=[]
    const auth={
      metadata:{mode,descriptorId:'scoped',workspaceId:'alpha',revision:1,keyRevision:1},
      admittedRepositories:new Set(['owner/allowed']),
      transport:{request:async()=>{throw new Error('unexpected hook request')}},
      repository:async repo=>{
        reads.push(repo);assert.equal(repo,'owner/allowed')
        return {nameWithOwner:repo,visibility:'PUBLIC',isArchived:false,isFork:false,viewerPermission:null,hookAdministration:true}
      },
    }
    for(const factory of [authenticatedGitHubFleetDependencies,authenticatedGitHubFleetRetirementDependencies]) {
      const result=await factory(auth).discover([root],{requiredRepositories:new Set(['owner/allowed'])})
      assert.deepEqual(result.blockers,[])
      assert.deepEqual(result.repositories.map(repo=>repo.nameWithOwner),['owner/allowed'])
      const blocked=await factory(auth).discover([root],{requiredRepositories:new Set(['owner/unrelated'])})
      assert.match(blocked.blockers.join(' '),/owner\/unrelated: required repository is outside selected authentication scope/)
    }
    assert.equal(reads.every(repo=>repo==='owner/allowed'),true)
  }finally{await rm(root,{recursive:true,force:true})}
})
