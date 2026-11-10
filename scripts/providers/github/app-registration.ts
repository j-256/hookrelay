import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { z } from 'zod'
import { GitHubAuthError, GITHUB_APP_LIMITS as LIMITS, githubHookCapability, githubProviderId } from '../../../src/lib/github-app-contract'
import { readGitHubAppJson, signGitHubAppJwt } from '../../../src/lib/github-app-token'
import { normalizeGitHubAppPrivateKey, readPrivateAppDocument, replacePrivateAppDocument, writeNewGitHubAppPrivateFile, writeNewPrivateAppDocument, type GitHubAppRecoveryFile } from './app-private-file'

const REGISTRATION_MS = 10 * 60 * 1000
const API = 'https://api.github.com'
const CLEAN_URL_SCRIPT = 'history.replaceState(null,"","/complete")'
const SCRIPT_HASH = createHash('sha256').update(CLEAN_URL_SCRIPT).digest('base64')
const identitySchema = z.object({ id: githubProviderId, slug: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/), owner: z.object({ id: githubProviderId, login: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/), type: z.enum(['User', 'Organization']) }) })
const registrationSchema = z.object({ account: z.object({ login: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/), type: z.enum(['User', 'Organization']) }).strict(), name: z.string().trim().min(1).max(80).regex(/^[\x20-\x7e]+$/), visibility: z.enum(['private', 'public']), homepage: z.url().max(2048), capability: githubHookCapability })
const importSchema = z.object({ version: z.literal(1), appId: githubProviderId, privateKey: z.string().max(LIMITS.PRIVATE_BYTES), webhookSecret: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/).optional() }).strict()
export type GitHubAppPreparation = { phase: 'prepared'; appId: number; slug: string; fingerprint: string; lifecycleIngress: 'inactive' }
export type GitHubAppRegistrationOptions = z.infer<typeof registrationSchema> & { attemptFile: string; outputFile: string; openBrowser: (url: string) => Promise<void>; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal }
const escapeHtml = (input: string) => input.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
function respond(response: ServerResponse, status: number, message: string, clean = false) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action https://github.com; script-src 'sha256-${SCRIPT_HASH}'` })
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Hookrelay App registration</title>${clean ? '<script>' + CLEAN_URL_SCRIPT + '</script>' : ''}<main>${message}</main></html>`)
}
async function githubJson(path: string, init: RequestInit, fetcher: typeof fetch, signal = AbortSignal.timeout(LIMITS.REQUEST_MS)) {
  try {
    const response = await fetcher(API + path, { ...init, redirect: 'manual', signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hookrelay-registration', ...init.headers } })
    if (!response.ok || response.status >= 300) { void response.body?.cancel().catch(() => {}); throw new Error() }
    return await readGitHubAppJson(response, signal)
  } catch { throw new GitHubAuthError('unavailable') }
}
function recovered(identity: z.infer<typeof identitySchema>, privateKey: string, webhookSecret?: string): GitHubAppRecoveryFile {
  const key = normalizeGitHubAppPrivateKey(privateKey)
  return { version: 1, kind: 'github-app', app: { id: identity.id, slug: identity.slug, ownerId: identity.owner.id, ownerLogin: identity.owner.login, ownerType: identity.owner.type }, privateKey: key.pkcs8, fingerprint: key.fingerprint, ...(webhookSecret ? { webhookSecret } : {}), createdAt: new Date().toISOString() }
}
const summary = (value: GitHubAppRecoveryFile): GitHubAppPreparation => ({ phase: 'prepared', appId: value.app.id, slug: value.app.slug, fingerprint: value.fingerprint, lifecycleIngress: 'inactive' })
export async function importGitHubAppMaterial(value: unknown, outputFile: string, fetcher: typeof fetch = fetch): Promise<GitHubAppPreparation> {
  const input = importSchema.safeParse(value)
  if (!input.success) throw new GitHubAuthError('validation')
  const key = normalizeGitHubAppPrivateKey(input.data.privateKey)
  const identity = identitySchema.safeParse(await githubJson('/app', { method: 'GET', headers: { Authorization: 'Bearer ' + await signGitHubAppJwt(key.pkcs8, input.data.appId, Date.now()) } }, fetcher))
  if (!identity.success || identity.data.id !== input.data.appId) throw new GitHubAuthError('denied')
  const recovery = recovered(identity.data, key.pkcs8, input.data.webhookSecret)
  await writeNewGitHubAppPrivateFile(outputFile, recovery)
  return summary(recovery)
}
export async function runGitHubAppRegistration(options: GitHubAppRegistrationOptions): Promise<GitHubAppPreparation> {
  const checked = registrationSchema.safeParse(options)
  if (!checked.success) throw new GitHubAuthError('validation')
  const input = checked.data
  const homepage = new URL(input.homepage)
  if (homepage.protocol !== 'https:' || homepage.username || homepage.password || homepage.search || homepage.hash) throw new GitHubAuthError('validation')
  try { await lstat(options.outputFile); throw new GitHubAuthError('validation') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GitHubAuthError('validation') }
  const state = randomBytes(32).toString('base64url')
  const callbackPath = '/callback/' + randomBytes(24).toString('hex')
  const formPath = '/register/' + randomBytes(24).toString('hex')
  let attempt: { version: number; kind: string; id: string; state: string; createdAt: number; expiresAt: number; stateHash: string; recovery?: GitHubAppRecoveryFile } = { version: 1, kind: 'github-app-registration', id: randomUUID(), state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + Math.min(options.timeoutMs ?? REGISTRATION_MS, REGISTRATION_MS), stateHash: createHash('sha256').update(state).digest('hex') }
  await writeNewPrivateAppDocument(options.attemptFile, attempt)
  let digest = (await readPrivateAppDocument(options.attemptFile)).digest
  let claimed = false
  let settled = false
  let origin = ''
  let resolveResult!: (value: GitHubAppPreparation) => void
  let rejectResult!: (error: GitHubAuthError) => void
  const result = new Promise<GitHubAppPreparation>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  const controller = new AbortController()
  const persist = async (next: typeof attempt) => { digest = await replacePrivateAppDocument(options.attemptFile, digest, next); attempt = next }
  const server = createServer((request, response) => { void handle(request, response).catch(async () => { respond(response, 503, '<p>Registration is uncertain. Inspect the protected attempt before recovery.</p>', true); await finish(undefined) }) })
  const finish = async (value: GitHubAppPreparation | undefined) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
    if (!value) await persist({ ...attempt, state: claimed ? 'indeterminate' : 'expired' }).catch(() => {})
    await new Promise<void>(resolve => { const force = setTimeout(() => server.closeAllConnections(), 1000); server.close(() => { clearTimeout(force); resolve() }); server.closeIdleConnections() })
    if (value) resolveResult(value); else rejectResult(new GitHubAuthError(claimed ? 'indeterminate' : 'unavailable'))
  }
  const abort = () => { void finish(undefined) }
  const timer = setTimeout(abort, Math.max(1, attempt.expiresAt - Date.now()))
  options.signal?.addEventListener('abort', abort, { once: true })
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (settled) { respond(response, 409, '<p>This attempt is closed.</p>', true); return }
    if (request.method !== 'GET' || request.headers.host !== new URL(origin).host) { respond(response, 403, '<p>Request refused.</p>'); return }
    const url = new URL(request.url ?? '/', origin)
    if (url.origin !== origin || (request.headers.origin && request.headers.origin !== origin && request.headers.origin !== 'https://github.com')) { respond(response, 403, '<p>Request refused.</p>'); return }
    if (url.pathname === formPath && !url.search) {
      const target = new URL(input.account.type === 'Organization' ? `https://github.com/organizations/${input.account.login}/settings/apps/new` : 'https://github.com/settings/apps/new')
      target.searchParams.set('state', state)
      const manifest = { name: input.name, url: homepage.href, public: input.visibility === 'public', redirect_url: origin + callbackPath, hook_attributes: { url: new URL('/github-app-events-disabled', homepage).href, active: false }, default_permissions: { repository_hooks: input.capability === 'repository-hooks-write' ? 'write' : 'read' }, default_events: [], request_oauth_on_install: false }
      respond(response, 200, `<h1>Register Hookrelay's GitHub App</h1><p>Review the account, visibility and repository Webhooks permission on GitHub. Installation and activation are separate steps.</p><form method="post" action="${escapeHtml(target.href)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form>`)
      return
    }
    if (url.pathname !== callbackPath || [...url.searchParams.keys()].some(key => !['state', 'code'].includes(key)) || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) { respond(response, 404, '<p>Request refused.</p>', true); return }
    const supplied = url.searchParams.get('state') ?? ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(supplied) || supplied.length !== state.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state)) || !/^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get('code') ?? '')) { respond(response, 403, '<p>Request refused.</p>', true); return }
    if (claimed) { respond(response, 409, '<p>Conversion was already claimed. Inspect its protected receipt.</p>', true); return }
    claimed = true
    await persist({ ...attempt, state: 'conversion_claimed' })
    const converted = await githubJson('/app-manifests/' + url.searchParams.get('code') + '/conversions', { method: 'POST' }, options.fetch ?? fetch, AbortSignal.any([controller.signal, AbortSignal.timeout(LIMITS.REQUEST_MS)]))
    const parsed = identitySchema.extend({ pem: z.string().max(LIMITS.PRIVATE_BYTES), webhook_secret: z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/) }).safeParse(converted)
    if (!parsed.success || parsed.data.owner.type !== input.account.type || parsed.data.owner.login.toLowerCase() !== input.account.login.toLowerCase() || settled) throw new GitHubAuthError('denied')
    const recovery = recovered(parsed.data, parsed.data.pem, parsed.data.webhook_secret)
    await persist({ ...attempt, state: 'conversion_claimed', recovery })
    await writeNewGitHubAppPrivateFile(options.outputFile, recovery)
    await persist({ ...attempt, state: 'prepared', recovery })
    respond(response, 200, '<p>Private recovery material was saved. Install the App, then prepare and verify activation separately.</p>', true)
    await finish(summary(recovery))
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error()
    origin = 'http://127.0.0.1:' + address.port
    if (options.signal?.aborted) throw new Error()
    void options.openBrowser(origin + formPath).catch(() => { void finish(undefined) })
  } catch { await finish(undefined) }
  return result
}
