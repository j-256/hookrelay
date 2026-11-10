import assert from 'node:assert/strict'
import {test} from 'node:test'
import {constants} from 'node:fs'
import {mkdtemp,readFile,open,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
async function readRecovery(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    assert.equal((await handle.stat()).mode & 0o777, 0o600)
    return JSON.parse(await handle.readFile('utf8'))
  } finally { await handle.close() }
}
test('low-level subscription setup writes bearer recovery privately instead of terminal logs',async () => {
  const root=await mkdtemp(join(tmpdir(),'hookrelay-private-output-'))
  try {
    const script=resolve('scripts/new-sub.ts')
    const output=join(root,'receiver.json')
    const result=await exec(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script,'repository','github','--private-export',output],{cwd:root,env:{PATH:process.env.PATH}})
    assert.equal(result.stderr.includes('/hook/'),false)
    const recovery=await readRecovery(output)
    assert.equal(recovery.kind,'hookrelay-subscription')
    assert.equal(recovery.webhookUrl.startsWith('https://hooks.example.com/hook/github/'),true)
    assert.equal(result.stdout.includes(recovery.webhookUrl),false)
  } finally {await rm(root,{recursive:true,force:true})}
})
test('guided manual GitHub setup retains URL and HMAC without printing either or contacting providers',async () => {
  const {writeFile}=await import('node:fs/promises')
  const root=await mkdtemp(join(tmpdir(),'hookrelay-guided-private-'))
  try {
    const script=resolve('scripts/sub-add.ts')
    const output=join(root,'receiver.json')
    await writeFile(join(root,'routes.jsonc'),JSON.stringify({subs:[],sinks:[{name:'discord',type:'discord',urlEnv:'SINK_DISCORD_URL'}]}))
    const result=await exec(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),script,'repository','github','--repo','owner/repo','--base-url','https://hooks.example','--events','manual','--private-export',output],{cwd:root,env:{PATH:process.env.PATH}})
    const recovery=await readRecovery(output)
    const logs=result.stdout+result.stderr
    assert.equal(logs.includes(recovery.webhookUrl),false)
    assert.equal(logs.includes(recovery.rawSlug),false)
    assert.equal(logs.includes(recovery.senderSecret.value),false)
    assert.equal(logs.includes(output),true)
    assert.equal((await readFile(join(root,'routes.jsonc'),'utf8')).includes(recovery.rawSlug),false)
  } finally {await rm(root,{recursive:true,force:true})}
})
