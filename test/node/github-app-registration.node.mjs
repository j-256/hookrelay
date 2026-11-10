import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runGitHubAppRegistration } from '../../scripts/providers/github/app-registration.ts'
import { parseGitHubAppArgs } from '../../scripts/github-app.ts'
const exec = promisify(execFile)
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const input = { account: { login: 'example', type: 'Organization' }, name: 'Provider App', visibility: 'public', homepage: 'https://hooks.example', capability: 'repository-hooks-write' }
const converted = () => ({ id: 42, slug: 'provider-app', owner: { id: 50, login: 'example', type: 'Organization' }, pem, webhook_secret: 'synthetic-manifest-secret', client_secret: 'discard-oauth-canary' })
async function withRoot(run) { const root = await mkdtemp(join(tmpdir(), 'hookrelay-app-registration-')); try { await run(root) } finally { await rm(root, { recursive: true, force: true }) } }
async function manifest(url) {
  const response = await fetch(url)
  const html = await response.text()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(html.includes(pem), false)
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  const form = decode(/value="([^"]+)"/.exec(html)[1])
  const data = JSON.parse(form)
  const action = new URL(decode(/action="([^"]+)"/.exec(html)[1]))
  assert.equal(data.hook_attributes.active, false)
  assert.deepEqual(data.default_permissions, { repository_hooks: 'write' })
  assert.deepEqual(data.default_events, [])
  return { url: new URL(data.redirect_url), state: action.searchParams.get('state') }
}
test('pins callback host, path and state and claims conversion only once before private persistence', async () => withRoot(async root => {
  let exchanges = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const result = await runGitHubAppRegistration({ ...input, attemptFile: join(root, 'attempt.json'), outputFile: join(root, 'recovery.json'), fetch: async (url, options) => { exchanges++; assert.match(String(url), /^https:\/\/api.github.com\/app-manifests\/[A-Za-z0-9]+\/conversions$/); assert.equal(options.redirect, 'manual'); await gate; return Response.json(converted()) }, openBrowser: async browserUrl => {
    const prepared = await manifest(browserUrl)
    const wrong = new URL(prepared.url); wrong.searchParams.set('state', 'wrong'); wrong.searchParams.set('code', 'synthetic-code')
    assert.equal((await fetch(wrong)).status, 403)
    wrong.searchParams.set('state', '\u00e9'.repeat(prepared.state.length))
    assert.equal((await fetch(wrong)).status, 403)
    const callback = prepared.url; callback.searchParams.set('state', prepared.state); callback.searchParams.set('code', 'syntheticcode')
    assert.equal((await fetch(callback, { headers: { origin: 'https://evil.example' } })).status, 403)
    const first = fetch(callback)
    while (!exchanges) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal((await fetch(callback)).status, 409)
    assert.equal(JSON.parse(await readFile(join(root, 'attempt.json'), 'utf8')).state, 'conversion_claimed')
    release()
    const response = await first
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.equal(html.includes('syntheticcode'), false)
    assert.equal(html.includes('history.replaceState'), true)
  } })
  assert.equal(exchanges, 1)
  assert.equal(result.phase, 'prepared')
  assert.equal((await stat(join(root, 'recovery.json'))).mode & 0o777, 0o600)
  const recovery = await readFile(join(root, 'recovery.json'), 'utf8')
  assert.equal(recovery.includes('discard-oauth-canary'), false)
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false)
}))
test('preserves an indeterminate conversion after a lost response without replay or claiming success', async () => withRoot(async root => {
  let exchanges = 0
  await assert.rejects(runGitHubAppRegistration({ ...input, attemptFile: join(root, 'attempt.json'), outputFile: join(root, 'recovery.json'), fetch: async () => { exchanges++; throw new Error('private-response-canary') }, openBrowser: async url => {
    const prepared = await manifest(url)
    prepared.url.searchParams.set('state', prepared.state); prepared.url.searchParams.set('code', 'syntheticcode')
    assert.equal((await fetch(prepared.url)).status, 503)
  } }))
  assert.equal(exchanges, 1)
  assert.equal(JSON.parse(await readFile(join(root, 'attempt.json'), 'utf8')).state, 'indeterminate')
  await assert.rejects(stat(join(root, 'recovery.json')))
}))
test('supports strict help and option grammar without credentials or remote effects', async () => {
  for (const args of [['-h'], ['--help']]) {
    assert.equal(parseGitHubAppArgs(args), null)
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/github-app.ts', ...args], { env: { PATH: process.env.PATH } })
    assert.match(result.stdout, /register.*import.*inspect/s)
    assert.equal(result.stderr, '')
  }
  for (const args of [['import', '-ifile', '-ooutput'], ['--file=file', 'import', '--output=output'], ['-i', 'file', '-o', 'output', '--', 'import']]) assert.equal(parseGitHubAppArgs(args).file, 'file')
  for (const args of [[], ['unknown'], ['import'], ['import', '-i', 'file', '--output='], ['inspect', '-i', 'file', '--key', 'secret'], ['inspect', '-i', 'one', '-i', 'two']]) assert.throws(() => parseGitHubAppArgs(args), { code: 'validation' })
})
test('times out an unused listener, refuses arbitrary hosts and paths, and does not exchange invalid callbacks', async () => withRoot(async root => {
  let exchange = 0
  await assert.rejects(runGitHubAppRegistration({ ...input, timeoutMs: 80, attemptFile: join(root, 'attempt.json'), outputFile: join(root, 'recovery.json'), fetch: async () => { exchange++; throw new Error() }, openBrowser: async browserUrl => {
    const wrongPath = new URL('/unknown', browserUrl)
    assert.equal((await fetch(wrongPath)).status, 404)
    const { request } = await import('node:http')
    const status = await new Promise((resolve,reject) => { const pending = request(browserUrl, {headers:{Host:'evil.example'}}, response => {response.resume();resolve(response.statusCode)}); pending.on('error',reject); pending.end() })
    assert.equal(status, 403)
  } }))
  assert.equal(exchange,0)
  assert.equal(JSON.parse(await readFile(join(root,'attempt.json'),'utf8')).state,'expired')
}))
test('retains complete private recovery in the attempt if the final output cannot be persisted', async () => withRoot(async root => {
  const { writeFile } = await import('node:fs/promises')
  const output = join(root,'recovery.json')
  await assert.rejects(runGitHubAppRegistration({ ...input, attemptFile: join(root,'attempt.json'), outputFile: output, fetch: async () => Response.json(converted()), openBrowser: async url => {
    const prepared = await manifest(url)
    await writeFile(output,'independent-file',{mode:0o600,flag:'wx'})
    prepared.url.searchParams.set('state',prepared.state);prepared.url.searchParams.set('code','syntheticcode')
    assert.equal((await fetch(prepared.url)).status,503)
  } }))
  const attempt = JSON.parse(await readFile(join(root,'attempt.json'),'utf8'))
  assert.equal(attempt.state,'indeterminate')
  assert.equal(attempt.recovery.app.id,42)
  assert.equal(attempt.recovery.webhookSecret,'synthetic-manifest-secret')
  assert.equal(await readFile(output,'utf8'),'independent-file')
}))
test('imports a matching App into a new protected file without retaining OAuth material or claiming activation', async () => withRoot(async root => {
  const { importGitHubAppMaterial } = await import('../../scripts/providers/github/app-registration.ts')
  const result = await importGitHubAppMaterial({ version:1,appId:42,privateKey:pem },join(root,'recovery.json'),async (url,options) => {
    assert.equal(String(url),'https://api.github.com/app');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual')
    return Response.json(converted())
  })
  assert.equal(result.phase,'prepared')
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'),false)
  await assert.rejects(importGitHubAppMaterial({version:1,appId:43,privateKey:pem},join(root,'wrong.json'),async () => Response.json(converted())))
}))
