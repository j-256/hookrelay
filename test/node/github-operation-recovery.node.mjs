import assert from 'node:assert/strict'
import {test} from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
test('documents bounded metadata inspection and protected explicit recovery without credentials for help',async () => {
  const result=await exec(process.execPath,['--import','tsx','scripts/github-operations.ts','--help'],{env:{PATH:process.env.PATH}})
  assert.match(result.stdout,/list.*reconcile/s)
  assert.match(result.stdout,/originalRequest/)
  assert.equal(result.stderr,'')
})
test('requires explicit scoped authentication and protected recovery inputs',async () => {
  const {parseGitHubOperationsArgs}=await import('../../scripts/github-operations.ts')
  const auth=['--github-auth','app','--github-descriptor','operator-auth','--github-workspace','alpha','--github-credential-file','private-file']
  assert.equal(parseGitHubOperationsArgs(['list',...auth]).command,'list')
  assert.equal(parseGitHubOperationsArgs(['reconcile',...auth,'-i','private-review','-y']).file,'private-review')
  for(const args of [['list'],['reconcile',...auth],['list',...auth,'-y'],['list',...auth,'--all','--all'],['list','--github-auth','gh']])assert.throws(()=>parseGitHubOperationsArgs(args),{code:'validation'})
})
