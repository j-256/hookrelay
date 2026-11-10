import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {discoverGitHubFleet, type GitHubFleetDiscoveryOptions} from '../src/discovery'
import type {GitHubOperatorAuth} from '../../../scripts/providers/github/auth'

export async function scopedDiscoveryFixture(directory:string, admitted:string, mode:'app'|'token') {
  const root=join(directory,'checkouts')
  const unrelated='outside/unrelated'
  for(const child of ['allowed','unrelated']) await mkdir(join(root,child),{recursive:true})
  const reads:string[]=[]
  const auth:GitHubOperatorAuth={
    metadata:{mode,descriptorId:'scoped-auth',workspaceId:'alpha',revision:1,keyRevision:1},
    admittedRepositories:new Set([admitted]),
    transport:{request:async()=>{throw new Error('unexpected provider hook request')}},
    repository:async repo=>{
      reads.push(repo)
      if(repo!==admitted)throw new Error(mode+' authentication scope denied')
      return {nameWithOwner:repo,visibility:'PUBLIC',isArchived:false,isFork:false,viewerPermission:null,hookAdministration:true}
    },
  }
  const discoverWithAuthority=(authority:GitHubOperatorAuth)=>async(_roots:readonly string[],options?:GitHubFleetDiscoveryOptions)=>discoverGitHubFleet([root],{
    ...options,admittedRepositories:authority.admittedRepositories,readRepositoryMetadata:authority.repository,
  },async(command,args)=>{
    if(command!=='git')throw new Error('ambient GitHub authentication is forbidden')
    if(args.includes('--show-toplevel'))return args[1]!
    return 'https://github.com/'+(args[1]!.endsWith('/allowed')?admitted:unrelated)+'.git'
  })
  return {root,reads,unrelated,auth,discoverWithAuthority,discover:discoverWithAuthority(auth)}
}
