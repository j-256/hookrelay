import { z } from 'zod'
import type { Env } from '../index'
import { configurationQuery, configurationDigest, type ConfigurationQuery } from '../configuration/authority'
import { githubAuthQuery, readGitHubAuthCandidate } from '../configuration/github-auth'
import { GitHubAuthError, githubAuthSecretName } from '../lib/github-app-contract'
import { githubAppKeyFingerprint } from '../lib/github-app-token'
import { githubTokenFingerprint } from '../lib/github-auth'

export const GITHUB_APP_KEY_VERIFICATION_PATH = '/management/github-app-key-verification'
export const GITHUB_APP_CHALLENGE_MS = 60000
const NONCE_BYTES = 32
const BODY_BYTES = 1024
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const bodySchema = z.object({ nonce: nonceSchema }).strict()
const nonceHash = (nonce: string) => configurationDigest({ kind: 'github-app-key-challenge', nonce })
export async function createGitHubAppKeyChallenge(
  query: ConfigurationQuery,
  candidateId: string,
  versionId: string,
  now = Date.now(),
) {
  const candidate = await readGitHubAuthCandidate(query, candidateId)
  if (
    candidate.descriptor.mode === 'gh' ||
    candidate.versionId !== versionId ||
    !['deployed', 'verified'].includes(candidate.state) ||
    candidate.expiresAt <= now
  )
    throw new GitHubAuthError('conflict')
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(NONCE_BYTES))))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  const id = crypto.randomUUID()
  await githubAuthQuery(
    query,
    'INSERT INTO github_auth_challenges(id,candidate_id,nonce_hash,version_id,fingerprint,expires_at) VALUES (?,?,?,?,?,?)',
    [
      id,
      candidateId,
      await nonceHash(nonce),
      versionId,
      candidate.descriptor.fingerprint,
      now + GITHUB_APP_CHALLENGE_MS,
    ],
  )
  return { nonce, expiresAt: now + GITHUB_APP_CHALLENGE_MS }
}
function response(value: unknown, status: number) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}
async function readBody(request: Request) {
  if (
    Number(request.headers.get('content-length')) > BODY_BYTES ||
    request.headers.get('content-type')?.split(';')[0] !== 'application/json' ||
    !request.body
  )
    throw new Error()
  const reader = request.body.getReader()
  const timeout = AbortSignal.timeout(2000)
  let cancel: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => {
      void reader.cancel()
      reject(new Error())
    }
    timeout.addEventListener('abort', cancel, { once: true })
  })
  const bytes = new Uint8Array(BODY_BYTES)
  let size = 0
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) break
      if (size + next.value.length > BODY_BYTES) throw new Error()
      bytes.set(next.value, size)
      size += next.value.length
    }
    return bodySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size))),
    )
  } finally {
    if (cancel) timeout.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export async function handleGitHubAppKeyVerification(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (
      request.method !== 'POST' ||
      url.pathname !== GITHUB_APP_KEY_VERIFICATION_PATH ||
      url.search ||
      (request.headers.get('origin') && request.headers.get('origin') !== url.origin) ||
      !env.CF_VERSION_METADATA?.id
    )
      throw new Error()
    const { nonce } = await readBody(request)
    const query = configurationQuery(env.EVENTS_DB)
    const now = Date.now()
    const [claimed] = await githubAuthQuery<{
      id: string
      candidate_id: string
      fingerprint: string
      expires_at: number
    }>(
      query,
      `UPDATE github_auth_challenges SET claimed_at=? WHERE nonce_hash=? AND claimed_at IS NULL AND expires_at>?
      AND version_id=? AND EXISTS(SELECT 1 FROM github_auth_candidates c WHERE c.id=candidate_id AND c.version_id=github_auth_challenges.version_id AND c.state IN ('deployed','verified') AND c.expires_at>?) RETURNING id,candidate_id,fingerprint,expires_at`,
      [now, await nonceHash(nonce), now, env.CF_VERSION_METADATA.id, now],
    )
    if (!claimed) throw new Error()
    const candidate = await readGitHubAuthCandidate(query, claimed.candidate_id)
    if (candidate.descriptor.mode === 'gh') throw new Error()
    const key = (env as unknown as Record<string, unknown>)[githubAuthSecretName(candidate.descriptor)]
    if (
      typeof key !== 'string' ||
      (await (candidate.descriptor.mode==='app' ? githubAppKeyFingerprint(key) : githubTokenFingerprint(key))) !== claimed.fingerprint ||
      candidate.descriptor.fingerprint !== claimed.fingerprint
    )
      throw new Error()
    const verifiedAt = Date.now()
    if (verifiedAt >= claimed.expires_at) throw new Error()
    const attestationId = crypto.randomUUID()
    const result = { attestationId, versionId: env.CF_VERSION_METADATA.id, fingerprint: claimed.fingerprint }
    const accepted = await githubAuthQuery(
      query,
      `INSERT INTO github_auth_attestations(id,candidate_id,account_id,worker_name,version_id,fingerprint,verified_at,expires_at)
      SELECT ?,id,account_id,worker_name,version_id,?,?,? FROM github_auth_candidates WHERE id=? AND version_id=? AND state IN ('deployed','verified') AND expires_at>? RETURNING id`,
      [
        attestationId,
        claimed.fingerprint,
        verifiedAt,
        Math.min(claimed.expires_at, verifiedAt + GITHUB_APP_CHALLENGE_MS),
        candidate.id,
        env.CF_VERSION_METADATA.id,
        verifiedAt,
      ],
    )
    if (!accepted.length) throw new Error()
    await githubAuthQuery(query, 'UPDATE github_auth_challenges SET result_json=? WHERE id=?', [
      JSON.stringify(result),
      claimed.id,
    ])
    return response(result, 200)
  } catch {
    return response({ error: 'unavailable' }, 404)
  }
}
