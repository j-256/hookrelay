import { z } from 'zod'
import { GitHubAuthError } from './github-app-contract'
export const GITHUB_HOOK_LIMITS = Object.freeze({ PAGES:3,PAGE_SIZE:100,PENDING:1000,LINK_CHARACTERS:8192,CURSOR_CHARACTERS:2048 })
export const githubRepositoryHookSchema=z.object({id:z.number().int().positive().safe(),active:z.boolean(),events:z.array(z.string().min(1).max(80)).max(100),updated_at:z.iso.datetime({offset:true}).optional(),config:z.object({url:z.string().max(2048),content_type:z.string(),insecure_ssl:z.union([z.string(),z.number()])})})
export function canonicalReceiverTarget(value:string) {
  const url=new URL(value)
  return url.origin+url.pathname.replace(/\/$/,'')+url.search
}
export function githubDeliveryCursor(link:string|null,repo:string,hookId:number):string|null {
  if(!link) return null
  if(link.length>GITHUB_HOOK_LIMITS.LINK_CHARACTERS) throw new GitHubAuthError('unavailable')
  let next:string|null=null
  for(const part of link.split(/,\s*(?=<)/)) {
    const match=/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part)
    if(!match) throw new GitHubAuthError('unavailable')
    if(!match[2]!.split(' ').includes('next')) continue
    if(next!==null) throw new GitHubAuthError('unavailable')
    const url=new URL(match[1]!,'https://api.github.com')
    if(url.origin!=='https://api.github.com'||url.username||url.password||url.hash||url.pathname!==`/repos/${repo}/hooks/${hookId}/deliveries`||[...url.searchParams.keys()].some(key=>!['cursor','per_page'].includes(key))||url.searchParams.getAll('cursor').length!==1||url.searchParams.getAll('per_page').length>1||(url.searchParams.has('per_page')&&url.searchParams.get('per_page')!==String(GITHUB_HOOK_LIMITS.PAGE_SIZE))) throw new GitHubAuthError('unavailable')
    const cursor=url.searchParams.get('cursor')!
    if(!cursor||cursor.length>GITHUB_HOOK_LIMITS.CURSOR_CHARACTERS||/[\x00-\x20\x7f]/.test(cursor)) throw new GitHubAuthError('unavailable')
    next=cursor
  }
  return next
}
