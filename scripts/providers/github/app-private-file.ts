import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { GITHUB_APP_LIMITS as LIMITS, GitHubAuthError, githubProviderId } from '../../../src/lib/github-app-contract'

export const githubAppRecoverySchema = z.object({
  version: z.literal(1), kind: z.literal('github-app'),
  app: z.object({ id: githubProviderId, slug: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), ownerId: githubProviderId, ownerLogin: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/), ownerType: z.enum(['User', 'Organization']) }).strict(),
  privateKey: z.string().min(1).max(LIMITS.PRIVATE_BYTES), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  webhookSecret: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional(),
  createdAt: z.iso.datetime(),
  deploymentReceipts: z.array(z.object({ candidateId:z.uuid(),phase:z.string().min(1).max(40),versionId:z.string().max(160).nullable(),attestationId:z.uuid().nullable(),recordedAt:z.iso.datetime() }).strict()).max(100).optional(),
}).strict()
export type GitHubAppRecoveryFile = z.infer<typeof githubAppRecoverySchema>
export function normalizeGitHubAppPrivateKey(input: string): { pkcs8: string; fingerprint: string } {
  try {
    if (Buffer.byteLength(input) > LIMITS.PRIVATE_BYTES || !/^\s*-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----\s*$/.test(input)) throw new Error()
    const key = createPrivateKey(input)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < LIMITS.MIN_RSA_BITS) throw new Error()
    return { pkcs8: key.export({ type: 'pkcs8', format: 'pem' }).toString(), fingerprint: createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex') }
  } catch { throw new GitHubAuthError('validation') }
}
export async function readPrivateAppDocument(path: string): Promise<{ value: unknown; digest: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size <= 0 || before.size > LIMITS.PRIVATE_BYTES) throw new Error()
    const bytes = Buffer.alloc(LIMITS.PRIVATE_BYTES + 1)
    let length = 0
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead }
    const after = await handle.stat()
    const current = await lstat(path)
    if (length !== before.size || length > LIMITS.PRIVATE_BYTES || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink()) throw new Error()
    const selected = bytes.subarray(0, length)
    try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected)), digest: createHash('sha256').update(selected).digest('hex') } }
    finally { bytes.fill(0) }
  } catch { throw new GitHubAuthError('validation') }
  finally { await handle?.close() }
}
async function privateParent(path: string) {
  const info = await lstat(dirname(resolve(path)))
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new GitHubAuthError('validation')
}
export async function writeNewPrivateAppDocument(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (!bytes.length || bytes.length > LIMITS.PRIVATE_BYTES) throw new GitHubAuthError('validation')
  await privateParent(path)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    created = true
    await handle.writeFile(bytes)
    await handle.sync()
    const info = await handle.stat()
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw new Error()
  } catch { if (created) await unlink(path).catch(() => {}); throw new GitHubAuthError('unavailable') }
  finally { bytes.fill(0); await handle?.close() }
}
export async function replacePrivateAppDocument(path: string, expectedDigest: string, value: unknown) {
  await privateParent(path)
  const lockPath = path + '.lock'
  const temporary = path + '.' + randomUUID() + '.tmp'
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let written = false
  try {
    lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const before = await readPrivateAppDocument(path)
    if (before.digest !== expectedDigest) throw new GitHubAuthError('conflict')
    await writeNewPrivateAppDocument(temporary, value)
    written = true
    if ((await readPrivateAppDocument(path)).digest !== expectedDigest) throw new GitHubAuthError('conflict')
    await rename(temporary, path)
    written = false
    const directory = await open(dirname(resolve(path)), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    return (await readPrivateAppDocument(path)).digest
  } catch (error) { if (error instanceof GitHubAuthError) throw error; throw new GitHubAuthError('unavailable') }
  finally { if (written) await unlink(temporary).catch(() => {}); if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}) } }
}
function normalizeRecovery(value: unknown): GitHubAppRecoveryFile {
  try {
    const recovery = githubAppRecoverySchema.parse(value)
    const normalized = normalizeGitHubAppPrivateKey(recovery.privateKey)
    if (normalized.fingerprint !== recovery.fingerprint) throw new Error()
    return { ...recovery, privateKey: normalized.pkcs8 }
  } catch { throw new GitHubAuthError('validation') }
}
export async function readGitHubAppPrivateFile(path: string): Promise<GitHubAppRecoveryFile> { return normalizeRecovery((await readPrivateAppDocument(path)).value) }
export async function writeNewGitHubAppPrivateFile(path: string, value: GitHubAppRecoveryFile): Promise<void> { await writeNewPrivateAppDocument(path, normalizeRecovery(value)) }

export const githubTokenRecoverySchema = z.object({
  version:z.literal(1),kind:z.literal('github-token'),token:z.string().min(1).max(LIMITS.MANUAL_TOKEN_BYTES).regex(/^[\x21-\x7e]+$/),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),
  deploymentReceipts:githubAppRecoverySchema.shape.deploymentReceipts,
}).strict()
export type GitHubTokenRecoveryFile = z.infer<typeof githubTokenRecoverySchema>
function normalizeTokenRecovery(input:unknown):GitHubTokenRecoveryFile {
  try {
    const value=githubTokenRecoverySchema.parse(input)
    if(createHash('sha256').update(value.token).digest('hex') !== value.fingerprint) throw new Error()
    return value
  } catch {throw new GitHubAuthError('validation')}
}

export async function readGitHubTokenPrivateFile(path:string):Promise<GitHubTokenRecoveryFile> {
  return normalizeTokenRecovery((await readPrivateAppDocument(path)).value)
}
export type GitHubCredentialRecoveryFile=GitHubAppRecoveryFile | GitHubTokenRecoveryFile
export async function readGitHubCredentialPrivateFile(path:string):Promise<GitHubCredentialRecoveryFile> {
  const value=(await readPrivateAppDocument(path)).value
  return value && typeof value==='object' && 'kind' in value && value.kind==='github-token' ? normalizeTokenRecovery(value) : normalizeRecovery(value)
}
export async function importGitHubTokenMaterial(input:unknown,output:string) {
  let value:GitHubTokenRecoveryFile
  try {
    const full=githubTokenRecoverySchema.safeParse(input)
    if(full.success)value=normalizeTokenRecovery(full.data)
    else {
      const parsed=z.object({version:z.literal(1),token:githubTokenRecoverySchema.shape.token}).strict().parse(input)
      value={...parsed,kind:'github-token',fingerprint:createHash('sha256').update(parsed.token).digest('hex'),createdAt:new Date().toISOString()}
    }
  } catch {throw new GitHubAuthError('validation')}
  await writeNewPrivateAppDocument(output,value)
  return {kind:value.kind,phase:'prepared',fingerprint:value.fingerprint,activation:'inactive'}
}
