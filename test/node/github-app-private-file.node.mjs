import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { mkdtemp, stat, symlink, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeGitHubAppPrivateKey, readGitHubAppPrivateFile, writeNewGitHubAppPrivateFile } from '../../scripts/providers/github/app-private-file.ts'
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const fingerprint = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const recovery = () => ({ version: 1, kind: 'github-app', app: { id: 42, slug: 'provider-app', ownerId: 50, ownerLogin: 'example', ownerType: 'Organization' }, privateKey: pem, fingerprint, webhookSecret: 'synthetic-webhook-secret', createdAt: new Date().toISOString() })
test('normalizes supported key encodings and refuses weak, non-RSA or concatenated material', () => {
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.deepEqual(normalizeGitHubAppPrivateKey(pem), { pkcs8, fingerprint })
  assert.deepEqual(normalizeGitHubAppPrivateKey(pkcs8), { pkcs8, fingerprint })
  assert.throws(() => normalizeGitHubAppPrivateKey(pem + pem))
  assert.throws(() => normalizeGitHubAppPrivateKey(generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()))
})
test('writes new owner-only recovery files without overwriting, following links or trusting a stale fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hookrelay-app-private-'))
  try {
    const file = join(root, 'recovery.json')
    await writeNewGitHubAppPrivateFile(file, recovery())
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readGitHubAppPrivateFile(file)).fingerprint, fingerprint)
    await assert.rejects(writeNewGitHubAppPrivateFile(file, recovery()))
    const link = join(root, 'link')
    await symlink(file, link)
    await assert.rejects(readGitHubAppPrivateFile(link))
    await chmod(file, 0o644)
    await assert.rejects(readGitHubAppPrivateFile(file))
    await assert.rejects(writeNewGitHubAppPrivateFile(join(root, 'mismatch'), { ...recovery(), fingerprint: 'a'.repeat(64) }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('keeps token material in the same strict private-file boundary and rejects local scope claims',async () => {
  const {writeNewPrivateAppDocument,readGitHubTokenPrivateFile}=await import('../../scripts/providers/github/app-private-file.ts')
  const root=await mkdtemp(join(tmpdir(),'hookrelay-token-private-'))
  try {
    const token='synthetic-manual-token'
    const value={version:1,kind:'github-token',token,fingerprint:createHash('sha256').update(token).digest('hex'),createdAt:new Date().toISOString()}
    const file=join(root,'token.json')
    await writeNewPrivateAppDocument(file,value)
    assert.equal((await readGitHubTokenPrivateFile(file)).token,token)
    const claimed=join(root,'claimed.json')
    await writeNewPrivateAppDocument(claimed,{...value,repositories:['owner/extra']})
    await assert.rejects(readGitHubTokenPrivateFile(claimed),{code:'validation'})
    await chmod(file,0o644)
    await assert.rejects(readGitHubTokenPrivateFile(file),{code:'validation'})
  }finally {await rm(root,{recursive:true,force:true})}
})

test('imports a manual token locally without provider calls or activation and inspects metadata only',async () => {
  const {parseGitHubAppArgs,runGitHubAppCommand}=await import('../../scripts/github-app.ts')
  const {writeNewPrivateAppDocument,readGitHubTokenPrivateFile}=await import('../../scripts/providers/github/app-private-file.ts')
  const root=await mkdtemp(join(tmpdir(),'hookrelay-manual-import-'))
  try {
    const input=join(root,'input.json'),output=join(root,'token.json')
    await writeNewPrivateAppDocument(input,{version:1,token:'synthetic-manual-import-token'})
    const options=parseGitHubAppArgs(['import-token','-i',input,'-o',output])
    const imported=await runGitHubAppCommand(options)
    assert.equal(imported.phase,'prepared')
    assert.equal(JSON.stringify(imported).includes('synthetic-manual-import-token'),false)
    assert.equal((await readGitHubTokenPrivateFile(output)).kind,'github-token')
    const inspected=await runGitHubAppCommand(parseGitHubAppArgs(['inspect','-i',output]))
    assert.equal(inspected.kind,'github-token')
    assert.equal(JSON.stringify(inspected).includes('synthetic-manual-import-token'),false)
    await assert.rejects(runGitHubAppCommand(options))
  } finally {await rm(root,{recursive:true,force:true})}
})
