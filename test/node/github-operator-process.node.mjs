import assert from 'node:assert/strict'
import {test} from 'node:test'
import {runProcess} from '../../scripts/setup.ts'
test('bounds private operator subprocess output and returns no captured body in diagnostics',async () => {
  let result
  try {await runProcess(process.execPath,['-e','process.stdout.write("x".repeat(10000))'],{captureStdout:true,privateInput:true,maxOutputBytes:100});result='unbounded'}catch(error){result=error.message}
  assert.notEqual(result,'unbounded')
  assert.equal(result.includes('x'.repeat(100)),false)
})
test('terminates a private operator process at its deadline',async () => {
  const start=Date.now()
  let result
  try {await runProcess(process.execPath,['-e','setTimeout(() => process.exit(0), 500)'],{captureStdout:true,privateInput:true,timeoutMs:40});result='not_bounded'}catch{result='bounded'}
  assert.equal(result,'bounded')
  assert.ok(Date.now()-start<450)
})
test('root and fleet CLIs reject incomplete authentication with usage status before provider work',async () => {
  const {execFile}=await import('node:child_process')
  const {promisify}=await import('node:util')
  const exec=promisify(execFile)
  for(const file of ['scripts/sub-add.ts','scripts/sub-retire.ts','scripts/providers/github/subscription-events.ts','scripts/providers/github/sync-events.ts','integrations/github-fleet/src/cli.ts']) {
    let failure
    try{await exec(process.execPath,['--import','tsx',file,'--github-auth=unknown'],{env:{PATH:process.env.PATH}})}catch(error){failure=error}
    assert.equal(failure?.code,2,file)
    assert.equal(failure?.stdout,'',file)
    assert.equal(failure?.stderr.includes('GitHub authentication validation'),true,file)
  }
})
