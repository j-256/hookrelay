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
