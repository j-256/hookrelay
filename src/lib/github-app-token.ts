import { z } from 'zod'
import { GITHUB_APP_LIMITS as LIMITS, GitHubAuthError, githubProviderId, githubRepository, githubHookCapability, type GitHubHookCapability } from './github-app-contract'

const API_ORIGIN = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const RSA = Object.freeze({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })
const ascii = new TextEncoder()
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const decode = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
async function importKey(pkcs8: string) {
  if (pkcs8.length > LIMITS.PRIVATE_BYTES || !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/.test(pkcs8)) throw new GitHubAuthError('validation')
  try {
    const key = await crypto.subtle.importKey('pkcs8', decode(pkcs8.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), RSA, true, ['sign'])
    const jwk = await crypto.subtle.exportKey('jwk', key) as JsonWebKey
    if (!jwk.n || !jwk.e) throw new Error()
    const modulus = decode(jwk.n)
    const bits = modulus.length * 8 - (Math.clz32(modulus[0] ?? 0) - 24)
    if (bits < LIMITS.MIN_RSA_BITS) throw new Error()
    return { key, jwk }
  } catch { throw new GitHubAuthError('validation') }
}
export async function githubAppKeyFingerprint(pkcs8: string) {
  const { jwk } = await importKey(pkcs8)
  const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, RSA, true, ['verify'])
  const digest = await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('spki', publicKey) as ArrayBuffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function signGitHubAppJwt(pkcs8: string, appId: number, now: number): Promise<string> {
  if (!githubProviderId.safeParse(appId).success || !Number.isFinite(now) || now < 0) throw new GitHubAuthError('validation')
  const { key } = await importKey(pkcs8)
  const seconds = Math.floor(now / 1000)
  const payload = encode(ascii.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))) + '.' + encode(ascii.encode(JSON.stringify({ iss: String(appId), iat: seconds - LIMITS.JWT_SKEW_SECONDS, exp: seconds + LIMITS.JWT_LIFETIME_SECONDS })))
  return payload + '.' + encode(new Uint8Array(await crypto.subtle.sign(RSA, key, ascii.encode(payload))))
}
export async function readGitHubAppJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new GitHubAuthError('unavailable')
  if (Number(response.headers.get('Content-Length')) > LIMITS.RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw new GitHubAuthError('unavailable') }
  let size = 0
  const chunks: Uint8Array[] = []
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => { abort = () => { void reader.cancel().catch(() => {}); reject(new GitHubAuthError('unavailable')) }; signal?.addEventListener('abort', abort, { once: true }) })
  try {
    if (signal?.aborted) throw new GitHubAuthError('unavailable')
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) break
      size += next.value.byteLength
      if (size > LIMITS.RESPONSE_BYTES) throw new GitHubAuthError('unavailable')
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch { throw new GitHubAuthError('unavailable') }
  finally { if (abort) signal?.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock() }
}
export type GitHubInstallationVerification = {
  appId: number; installationId: number; accountId: number; privateKey: string; fingerprint: string;
  repositories: z.infer<typeof githubRepository>[]; capability: GitHubHookCapability;
  now?: () => number; fetch?: typeof fetch; remainingBudgetMs?: () => number
}
export type GitHubTokenRequest = GitHubInstallationVerification & { cache?: boolean }
export type GitHubInstallationObservation = { appId: number; installationId: number; accountId: number; permissions: Record<string, 'read' | 'write' | 'admin'> }
export type GitHubInstallationToken = { token: string; expiresAt: number; repositoryIds: number[]; permissions: { repository_hooks: 'read' | 'write' } }
const permissionsSchema = z.record(z.string().max(80), z.enum(['read', 'write', 'admin'])).refine(value => Object.keys(value).length <= 100)
const installationSchema = z.object({ id: githubProviderId, app_id: githubProviderId, account: z.object({ id: githubProviderId }), permissions: permissionsSchema, suspended_at: z.iso.datetime({ offset: true }).nullable() })
const tokenSchema = z.object({ token: z.string().min(1).max(LIMITS.TOKEN_BYTES).regex(/^[\x21-\x7e]+$/), expires_at: z.iso.datetime({ offset: true }), permissions: permissionsSchema, repositories: z.array(z.object({ id: githubProviderId, full_name: z.string().max(201), private: z.boolean(), owner: z.object({ id: githubProviderId }) })).min(1).max(LIMITS.REPOSITORIES) })
const scopeSchema = z.object({ appId: githubProviderId, installationId: githubProviderId, accountId: githubProviderId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), repositories: z.array(githubRepository).min(1).max(LIMITS.REPOSITORIES).refine(rows => new Set(rows.map(row => row.id)).size === rows.length), capability: githubHookCapability })
const requiredPermission = (capability: GitHubHookCapability) => capability === 'repository-hooks-write' ? 'write' as const : 'read' as const
async function validate(input: GitHubInstallationVerification) {
  if (!scopeSchema.safeParse(input).success || await githubAppKeyFingerprint(input.privateKey) !== input.fingerprint) throw new GitHubAuthError('validation')
}
async function request(input: GitHubInstallationVerification, token: boolean) {
  const budget = Math.min(LIMITS.REQUEST_MS, input.remainingBudgetMs?.() ?? LIMITS.REQUEST_MS)
  if (!Number.isFinite(budget) || budget <= 0) throw new GitHubAuthError('not_sent')
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(budget)))
  const authorization = await signGitHubAppJwt(input.privateKey, input.appId, (input.now ?? Date.now)())
  if (signal.aborted || (input.remainingBudgetMs?.() ?? 1) <= 0) throw new GitHubAuthError('not_sent')
  try {
    const response = await (input.fetch ?? fetch)(`${API_ORIGIN}/app/installations/${input.installationId}${token ? '/access_tokens' : ''}`, {
      method: token ? 'POST' : 'GET', redirect: 'manual', signal,
      headers: { Authorization: 'Bearer ' + authorization, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'hookrelay', ...(token ? { 'Content-Type': 'application/json' } : {}) },
      ...(token ? { body: JSON.stringify({ repository_ids: input.repositories.map(row => row.id).sort((a, b) => a - b), permissions: { repository_hooks: requiredPermission(input.capability) } }) } : {}),
    })
    if (!response.ok) void response.body?.cancel().catch(() => {})
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const now = (input.now ?? Date.now)()
      throw new GitHubAuthError('rate_limited', Math.max(now + LIMITS.AUTHORITY_AGE_MS, Math.min(Number.isFinite(reset) ? reset : now, now + LIMITS.COOLDOWN_MAX_MS)))
    }
    if ([401, 403, 404].includes(response.status)) throw new GitHubAuthError('denied')
    if (!response.ok || response.status >= 300) throw new GitHubAuthError('unavailable')
    return await readGitHubAppJson(response, signal)
  } catch (error) { if (error instanceof GitHubAuthError) throw error; throw new GitHubAuthError('unavailable') }
}
export async function verifyGitHubInstallation(input: GitHubInstallationVerification): Promise<GitHubInstallationObservation> {
  await validate(input)
  const parsed = installationSchema.safeParse(await request(input, false))
  if (!parsed.success) throw new GitHubAuthError('unavailable')
  const value = parsed.data
  if (value.id !== input.installationId || value.app_id !== input.appId || value.account.id !== input.accountId || value.suspended_at || !value.permissions.repository_hooks || (requiredPermission(input.capability) === 'write' && !['write', 'admin'].includes(value.permissions.repository_hooks))) throw new GitHubAuthError('denied')
  return { appId: value.app_id, installationId: value.id, accountId: value.account.id, permissions: value.permissions }
}
const caches = new WeakMap<typeof fetch, Map<string, { result?: GitHubInstallationToken; pending?: Promise<GitHubInstallationToken> }>>()
export function evictGitHubInstallationToken(input: GitHubTokenRequest) { caches.get(input.fetch ?? fetch)?.delete(cacheKey(input)) }
function cacheKey(input: GitHubTokenRequest) { return JSON.stringify([input.appId, input.installationId, input.fingerprint, input.capability, input.repositories.map(repo => [repo.id, repo.fullName, repo.ownerId, repo.private]).sort((a, b) => Number(a[0]) - Number(b[0]))]) }
export async function mintGitHubInstallationToken(input: GitHubTokenRequest): Promise<GitHubInstallationToken> {
  await validate(input)
  const fetcher = input.fetch ?? fetch
  let cache = caches.get(fetcher)
  if (!cache) { cache = new Map(); caches.set(fetcher, cache) }
  const key = cacheKey(input)
  const now = (input.now ?? Date.now)()
  if (input.cache !== false) {
    const existing = cache.get(key)
    if (existing?.result && existing.result.expiresAt - LIMITS.TOKEN_MARGIN_MS > now) return existing.result
    if (existing?.pending) return existing.pending
    for (const [id, entry] of cache) if (!entry.pending && (!entry.result || entry.result.expiresAt - LIMITS.TOKEN_MARGIN_MS <= now)) cache.delete(id)
    if (cache.size >= LIMITS.CACHE_ENTRIES) throw new GitHubAuthError('unavailable')
  }
  const mint = async (): Promise<GitHubInstallationToken> => {
    const parsed = tokenSchema.safeParse(await request(input, true))
    if (!parsed.success) throw new GitHubAuthError('unavailable')
    const value = parsed.data
    const expiry = Date.parse(value.expires_at)
    const current = (input.now ?? Date.now)()
    if (expiry <= current + LIMITS.TOKEN_MARGIN_MS || expiry > current + LIMITS.TOKEN_LIFETIME_MS || value.permissions.repository_hooks !== requiredPermission(input.capability) || Object.entries(value.permissions).some(([name, level]) => name !== 'repository_hooks' && !(name === 'metadata' && level === 'read')) || value.repositories.length !== input.repositories.length || new Set(value.repositories.map(repo => repo.id)).size !== value.repositories.length || value.repositories.some(repo => !input.repositories.some(expected => expected.id === repo.id && expected.fullName === repo.full_name && expected.private === repo.private && expected.ownerId === repo.owner.id && repo.owner.id === input.accountId))) throw new GitHubAuthError('denied')
    return { token: value.token, expiresAt: expiry, repositoryIds: input.repositories.map(row => row.id), permissions: { repository_hooks: requiredPermission(input.capability) } }
  }
  const pending = mint()
  if (input.cache === false) return pending
  const entry = { pending } as { pending?: Promise<GitHubInstallationToken>; result?: GitHubInstallationToken }
  cache.set(key, entry)
  try { const result = await pending; if (cache.get(key) === entry) { entry.result = result; delete entry.pending }; return result }
  catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error }
}
