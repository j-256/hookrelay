import { z } from 'zod'
import { configurationDigest, type ConfigurationQuery } from '../../../src/configuration/authority'
import {
  readGitHubAuthDescriptor,
  githubAuthQuery,
  githubAuthFencePredicate,
  assertGitHubAuthFence,
} from '../../../src/configuration/github-auth'
import {
  resolveGitHubAuth,
  recordGitHubAuthResponse,
  githubTokenFingerprint,
} from '../../../src/lib/github-auth'
import { githubAppKeyFingerprint, readGitHubAppJson } from '../../../src/lib/github-app-token'
import {
  GitHubAuthError,
  GITHUB_APP_LIMITS,
  githubAuthId,
  type GitHubAuthDescriptor,
  type GitHubHookCapability,
  type GitHubAuthLease,
} from '../../../src/lib/github-app-contract'
import { githubRetryAt } from '../../../src/lib/github-rate-limit'
import { fetchGitHubWithDeadline } from '../../../src/lib/github-http'
import { operatorConfigurationQuery } from '../../configuration-client'
import { runProcess } from '../../setup'
import {
  readGitHubAppPrivateFile,
  readGitHubTokenPrivateFile,
  type GitHubAppRecoveryFile,
} from './app-private-file'

const HOOK_TRANSPORT_LIMITS = Object.freeze({ PAGES: 3, PAGE_SIZE: 100, PENDING: 1000 })
const repo = z
  .string()
  .max(201)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!))
const hookId = z.number().int().positive().safe()
const body = {
  webhookUrl: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    }),
  secret: z.string().min(1).max(4096),
  events: z
    .array(
      z
        .string()
        .min(1)
        .max(80)
        .regex(/^[A-Za-z0-9_*]+$/),
    )
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length),
}
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list'), repo }).strict(),
  z
    .object({
      operation: z.literal('repository'),
      repo,
      intent: z.enum(['read', 'manage']).default('read'),
    })
    .strict(),
  z.object({ operation: z.literal('create'), repo, ...body }).strict(),
  z
    .object({
      operation: z.literal('update'),
      repo,
      hookId,
      ...body,
      active: z.boolean().default(true),
    })
    .strict(),
  z.object({ operation: z.literal('events'), repo, hookId, ...body, active: z.boolean() }).strict(),
  ...(['delete', 'deliveries', 'ping'] as const).map((operation) =>
    z.object({ operation: z.literal(operation), repo, hookId }).strict(),
  ),
])
export function parseGitHubHookRequest(input: unknown) {
  const value = requestSchema.safeParse(input)
  if (!value.success) throw new GitHubAuthError('validation')
  return value.data
}
export type GitHubHookRequest = z.input<typeof requestSchema>
export interface GitHubHookTransport {
  request(input: GitHubHookRequest): Promise<unknown>
}
export type OperatorGitHubAuthOptions = {
  mode: 'app' | 'token' | 'gh'
  descriptorId?: string
  workspaceId?: string
  credentialFile?: string
  config?: string
}
export type GitHubOperatorAuth = {
  admittedRepositories?: ReadonlySet<string>
  metadata: {
    mode: OperatorGitHubAuthOptions['mode']
    descriptorId: string | null
    workspaceId: string | null
    revision: number | null
    keyRevision: number | null
    appId?: number
    installationId?: number
    fingerprint?: string
  }
  transport: GitHubHookTransport
  verifyRepositoryAuthority?: (repo: string) => Promise<GitHubAuthLease['fence']>
  repository(repo: string): Promise<{
    nameWithOwner: string
    visibility: string
    isArchived: boolean
    isFork: boolean
    viewerPermission: string | null
    hookAdministration: boolean
  }>
}
export type OperatorGitHubAuthDependencies = {
  query?: ConfigurationQuery
  fetch?: typeof fetch
  runner?: typeof runProcess
  readAppMaterial?: (path: string) => Promise<GitHubAppRecoveryFile>
  readTokenMaterial?: (path: string) => Promise<string>
}
export class GitHubHookOperationError extends GitHubAuthError {
  constructor(
    code: GitHubAuthError['code'],
    readonly operationId: string,
    retryAt: number | null = null,
  ) {
    super(code, retryAt)
    this.message +=
      '; inspect operator operation ' +
      operationId +
      (retryAt ? '; retry after ' + new Date(retryAt).toISOString() : '')
  }
}
export function extractOperatorGitHubAuthArgs(argv: readonly string[]) {
  const names = new Map([
    ['--github-auth', 'mode'],
    ['--github-descriptor', 'descriptorId'],
    ['--github-workspace', 'workspaceId'],
    ['--github-credential-file', 'credentialFile'],
  ])
  const args: string[] = []
  const fields: Record<string, string> = {}
  let ended = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (ended) {
      args.push(arg)
      continue
    }
    if (arg === '--') {
      ended = true
      args.push(arg)
      continue
    }
    const split = arg.indexOf('=')
    const flag = split < 0 ? arg : arg.slice(0, split)
    const key = names.get(flag)
    if (!key) {
      if (flag.startsWith('--github-')) throw new GitHubAuthError('validation')
      args.push(arg)
      continue
    }
    const value = split < 0 ? argv[++index] : arg.slice(split + 1)
    if (fields[key] !== undefined || !value || value.startsWith('-'))
      throw new GitHubAuthError('validation')
    fields[key] = value
  }
  if (!Object.keys(fields).length) return { args, authentication: undefined }
  if (
    !['app', 'token', 'gh'].includes(fields.mode ?? '') ||
    (fields.mode === 'gh'
      ? Object.keys(fields).length !== 1
      : !fields.descriptorId || !fields.workspaceId || !fields.credentialFile)
  )
    throw new GitHubAuthError('validation')
  return { args, authentication: fields as OperatorGitHubAuthOptions }
}
export const OPERATOR_GITHUB_AUTH_USAGE =
  '--github-auth app|token|gh; App/token also require --github-descriptor <id>, --github-workspace <id>, --github-credential-file <protected-file>'
function canonicalReceiverTarget(value: string) {
  const url = new URL(value)
  return url.origin + url.pathname.replace(/\/$/, '') + url.search
}
function operation(input: z.output<typeof requestSchema>, page = 1) {
  const path = `repos/${input.repo}`
  switch (input.operation) {
    case 'repository':
      return { method: 'GET', path }
    case 'list':
      return {
        method: 'GET',
        path: path + `/hooks?per_page=${HOOK_TRANSPORT_LIMITS.PAGE_SIZE}&page=${page}`,
      }
    case 'deliveries':
      return {
        method: 'GET',
        path:
          path +
          `/hooks/${input.hookId}/deliveries?per_page=${HOOK_TRANSPORT_LIMITS.PAGE_SIZE}&page=${page}`,
      }
    case 'delete':
      return { method: 'DELETE', path: path + `/hooks/${input.hookId}` }
    case 'ping':
      return { method: 'POST', path: path + `/hooks/${input.hookId}/pings` }
    case 'create':
      return {
        method: 'POST',
        path: path + '/hooks',
        body: {
          name: 'web',
          active: true,
          events: input.events,
          config: {
            url: input.webhookUrl,
            secret: input.secret,
            content_type: 'json',
            insecure_ssl: '0',
          },
        },
      }
    case 'update':
    case 'events':
      return {
        method: 'PATCH',
        path: path + `/hooks/${input.hookId}`,
        body: {
          active: input.active,
          events: input.events,
          config: {
            url: input.webhookUrl,
            secret: input.secret,
            content_type: 'json',
            insecure_ssl: '0',
          },
        },
      }
  }
}
export async function resolveOperatorGitHubAuth(
  options: OperatorGitHubAuthOptions,
  dependencies: OperatorGitHubAuthDependencies = {},
): Promise<GitHubOperatorAuth> {
  if (!options || !['app', 'token', 'gh'].includes(options.mode))
    throw new GitHubAuthError('validation')
  const runner = dependencies.runner ?? runProcess
  const fetcher = dependencies.fetch ?? fetch
  const readApp = dependencies.readAppMaterial ?? readGitHubAppPrivateFile
  const readToken =
    dependencies.readTokenMaterial ??
    (async (path) => (await readGitHubTokenPrivateFile(path)).token)
  if (
    options.mode === 'gh' &&
    (options.descriptorId || options.workspaceId || options.credentialFile)
  )
    throw new GitHubAuthError('validation')
  const query =
    options.mode === 'gh'
      ? null
      : (dependencies.query ?? (await operatorConfigurationQuery(options.config)))
  let descriptor: GitHubAuthDescriptor | null = null
  if (query) {
    if (
      !githubAuthId.safeParse(options.workspaceId).success ||
      !githubAuthId.safeParse(options.descriptorId).success ||
      !options.credentialFile
    )
      throw new GitHubAuthError('validation')
    descriptor = await readGitHubAuthDescriptor(query, {
      mode: options.mode,
      descriptorId: options.descriptorId!,
    })
    if (!descriptor.managementWorkspaces.includes(options.workspaceId!))
      throw new GitHubAuthError('denied')
    if (descriptor.mode === 'app') {
      const material = await readApp(options.credentialFile)
      if (
        material.app.id !== descriptor.appId ||
        material.fingerprint !== descriptor.fingerprint ||
        (await githubAppKeyFingerprint(material.privateKey)) !== descriptor.fingerprint
      )
        throw new GitHubAuthError('denied')
    } else if (descriptor.mode === 'token') {
      if (
        (await githubTokenFingerprint(await readToken(options.credentialFile))) !==
        descriptor.fingerprint
      )
        throw new GitHubAuthError('denied')
    }
  }
  const captured = descriptor
  const pinned = new Map<string, string>()
  async function lease(
    repositoryFullName: string,
    capability: GitHubHookCapability,
    phase: 'read' | 'effect',
    signal: AbortSignal,
    refreshToken = false,
  ): Promise<GitHubAuthLease> {
    if (!query || !captured) throw new GitHubAuthError('unavailable')
    const current = await readGitHubAuthDescriptor(query, {
      mode: options.mode,
      descriptorId: captured.id,
    })
    if (current.revision !== captured.revision || current.keyRevision !== captured.keyRevision)
      throw new GitHubAuthError('conflict')
    const started = Date.now()
    const value = await resolveGitHubAuth({
      query,
      selection: { mode: options.mode, descriptorId: captured.id },
      workspaceId: options.workspaceId!,
      callerId: 'cloudflare-operator',
      repositoryFullName,
      capability,
      phase,
      signal,
      refreshToken,
      fetch: fetcher,
      remainingBudgetMs: () =>
        signal.aborted ? 0 : Math.max(0, GITHUB_APP_LIMITS.REQUEST_MS - (Date.now() - started)),
      loadPrivateKey: async (current) => {
        const material = await readApp(options.credentialFile!)
        if (
          current.mode !== 'app' ||
          current.appId !== material.app.id ||
          current.fingerprint !== material.fingerprint
        )
          throw new GitHubAuthError('denied')
        return material.privateKey
      },
      loadToken: async () => readToken(options.credentialFile!),
    })
    const key = [repositoryFullName, capability].join(':')
    const before = pinned.get(key)
    if (before && before !== value.authorityIdentity) throw new GitHubAuthError('conflict')
    pinned.set(key, value.authorityIdentity)
    return value
  }
  async function request(input: GitHubHookRequest): Promise<unknown> {
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new GitHubAuthError('validation')
    const requested = parsed.data
    const write = !['list', 'repository', 'deliveries'].includes(requested.operation)
    const capability =
      write || (requested.operation === 'repository' && requested.intent === 'manage')
        ? 'repository-hooks-write'
        : 'repository-hooks-read'
    const signal = AbortSignal.timeout(GITHUB_APP_LIMITS.REQUEST_MS)
    let operationId: string | null = null
    let dispatched = false
    let accepted = false
    let providerStatus: number | null = null
    let current: GitHubAuthLease | null = null
    const pages: unknown[] = []
    try {
      if (query && captured) {
        current = await lease(requested.repo, capability, 'read', signal)
        if (write) {
          operationId = crypto.randomUUID()
          const requestHash = await configurationDigest(requested)
          const targetHash = await configurationDigest({
            repositoryId: current.fence.repositoryId,
            target:
              'webhookUrl' in requested
                ? canonicalReceiverTarget(requested.webhookUrl)
                : 'hookId' in requested
                  ? requested.hookId
                  : requested.operation,
          })
          const inserted = await githubAuthQuery(
            query,
            `INSERT INTO github_hook_operations(id,descriptor_id,workspace_id,repository_id,operation,hook_id,request_hash,target_hash,auth_fence_json,state,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,'prepared',?,? WHERE (SELECT count(*) FROM github_hook_operations WHERE descriptor_id=? AND state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id))<?
            AND (?='ping' OR NOT EXISTS(SELECT 1 FROM github_hook_operations WHERE descriptor_id=? AND repository_id=? AND target_hash=? AND state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id))) RETURNING id`,
            [
              operationId,
              captured.id,
              options.workspaceId!,
              current.fence.repositoryId,
              requested.operation,
              'hookId' in requested ? requested.hookId : null,
              requestHash,
              targetHash,
              JSON.stringify(current.fence),
              Date.now(),
              Date.now(),
              captured.id,
              HOOK_TRANSPORT_LIMITS.PENDING,
              requested.operation,
              captured.id,
              current.fence.repositoryId,
              targetHash,
            ],
          )
          if (!inserted.length) {
            operationId = null
            const [pending] = await githubAuthQuery<{ id: string }>(
              query,
              "SELECT id FROM github_hook_operations WHERE descriptor_id=? AND repository_id=? AND target_hash=? AND state IN ('prepared','submitting','indeterminate') AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id) ORDER BY created_at LIMIT 1",
              [captured.id, current.fence.repositoryId, targetHash],
            )
            if (pending) throw new GitHubHookOperationError('indeterminate', pending.id)
            throw new GitHubAuthError('unavailable')
          }
          current = await lease(requested.repo, capability, 'effect', signal)
          const guard = githubAuthFencePredicate(current.fence)
          if (
            !(
              await githubAuthQuery(
                query,
                `UPDATE github_hook_operations SET state='submitting',auth_fence_json=?,updated_at=? WHERE id=? AND state='prepared' AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id) AND (${guard.sql}) RETURNING id`,
                [JSON.stringify(current.fence), Date.now(), operationId, ...guard.params],
              )
            ).length
          )
            throw new GitHubAuthError('conflict')
        }
      }
      for (let page = 1; page <= HOOK_TRANSPORT_LIMITS.PAGES; page++) {
        const target = operation(requested, page)
        const serialized = 'body' in target ? JSON.stringify(target.body) : undefined
        let value: unknown
        if (options.mode === 'gh') {
          const output = await runner(
            'gh',
            [
              'api',
              '--hostname',
              'github.com',
              '--header',
              'Accept: application/vnd.github+json',
              '--header',
              'X-GitHub-Api-Version: 2022-11-28',
              '--method',
              target.method,
              target.path,
              ...(serialized ? ['--input', '-'] : []),
            ],
            {
              input: serialized,
              captureStdout: true,
              privateInput: true,
              timeoutMs: GITHUB_APP_LIMITS.REQUEST_MS,
              maxOutputBytes: GITHUB_APP_LIMITS.RESPONSE_BYTES,
            },
          )
          value = output ? (JSON.parse(output) as unknown) : null
        } else {
          if (page > 1) current = await lease(requested.repo, capability, 'read', signal)
          if (!current) throw new GitHubAuthError('unavailable')
          const send = async (credential: GitHubAuthLease) =>
            fetchGitHubWithDeadline(
              fetcher,
              'https://api.github.com/' + target.path,
              {
                method: target.method,
                redirect: 'manual',
                signal,
                headers: {
                  authorization: 'Bearer ' + credential.token,
                  accept: 'application/vnd.github+json',
                  'x-github-api-version': '2022-11-28',
                  'user-agent': 'Hookrelay',
                  ...(serialized ? { 'content-type': 'application/json' } : {}),
                },
                ...(serialized ? { body: serialized } : {}),
              },
              write
                ? () => {
                    dispatched = true
                  }
                : undefined,
            )
          let response = await send(current)
          if (response.status === 401 && captured?.mode === 'app') {
            void response.body?.cancel().catch(() => {})
            dispatched = false
            current = await lease(
              requested.repo,
              capability,
              write ? 'effect' : 'read',
              signal,
              true,
            )
            response = await send(current)
          }
          providerStatus = response.status
          const expected =
            requested.operation === 'create'
              ? 201
              : requested.operation === 'delete' || requested.operation === 'ping'
                ? 204
                : 200
          accepted = write && response.status === expected
          await recordGitHubAuthResponse(query!, current.quotaKey, response)
          const retryAt = githubRetryAt(response)
          if (retryAt !== null) {
            dispatched = false
            void response.body?.cancel().catch(() => {})
            throw new GitHubAuthError('rate_limited', retryAt)
          }
          if (response.status !== expected) {
            void response.body?.cancel().catch(() => {})
            if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
              dispatched = false
              throw new GitHubAuthError('denied')
            }
            throw new GitHubAuthError('unavailable')
          }
          value =
            requested.operation === 'delete' || requested.operation === 'ping'
              ? null
              : await readGitHubAppJson(response, signal)
          if (value === null) void response.body?.cancel().catch(() => {})
          if (!write) await assertGitHubAuthFence(query!, current.fence)
          if (requested.operation === 'repository') {
            const observed = z
              .object({
                id: hookId,
                full_name: z.string(),
                private: z.boolean(),
                owner: z.object({ id: hookId }),
              })
              .parse(value)
            const expected = captured?.repositories.find(
              (repo) => repo.id === current!.fence.repositoryId,
            )
            if (
              !expected ||
              observed.id !== expected.id ||
              observed.full_name !== expected.fullName ||
              observed.private !== expected.private ||
              observed.owner.id !== expected.ownerId
            )
              throw new GitHubAuthError('denied')
          }
        }
        if (requested.operation === 'list' || requested.operation === 'deliveries') {
          const rows = z.array(z.unknown()).max(HOOK_TRANSPORT_LIMITS.PAGE_SIZE).parse(value)
          pages.push(...rows)
          if (rows.length === HOOK_TRANSPORT_LIMITS.PAGE_SIZE) {
            if (page === HOOK_TRANSPORT_LIMITS.PAGES) throw new GitHubAuthError('unavailable')
            continue
          }
          return pages
        }
        if (operationId && query && current) {
          const guard = githubAuthFencePredicate(current.fence)
          const id =
            requested.operation === 'create'
              ? z.object({ id: hookId }).parse(value).id
              : 'hookId' in requested
                ? requested.hookId
                : null
          await githubAuthQuery(
            query,
            `UPDATE github_hook_operations SET state='accepted',hook_id=?,provider_status=?,verified=CASE WHEN (${guard.sql}) THEN 1 ELSE 0 END,error_code=CASE WHEN (${guard.sql}) THEN NULL ELSE 'authority_changed' END,updated_at=? WHERE id=? AND state='submitting'`,
            [id, providerStatus, ...guard.params, ...guard.params, Date.now(), operationId],
          )
        }
        return value
      }
      throw new GitHubAuthError('unavailable')
    } catch (error) {
      if (
        options.mode === 'gh' &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        throw Object.assign(new Error('The explicitly selected gh client is unavailable'), {
          code: 'ENOENT',
        })
      if (operationId && query)
        await githubAuthQuery(
          query,
          "UPDATE github_hook_operations SET state=?,provider_status=?,error_code=?,updated_at=? WHERE id=? AND state IN ('prepared','submitting')",
          [
            dispatched ? 'indeterminate' : 'rejected',
            providerStatus,
            accepted
              ? 'acknowledged_unverified'
              : error instanceof GitHubAuthError
                ? error.code
                : 'unavailable',
            Date.now(),
            operationId,
          ],
        )
      const code = dispatched
        ? 'indeterminate'
        : error instanceof GitHubAuthError
          ? error.code
          : 'unavailable'
      if (operationId)
        throw new GitHubHookOperationError(
          code,
          operationId,
          error instanceof GitHubAuthError ? error.retryAt : null,
        )
      if (error instanceof GitHubAuthError) throw error
      throw new GitHubAuthError(options.mode === 'gh' && write ? 'indeterminate' : code)
    }
  }
  return {
    admittedRepositories: captured ? new Set(captured.repositories.map(repo => repo.fullName)) : undefined,
    metadata: {
      mode: options.mode,
      descriptorId: captured?.id ?? null,
      workspaceId: options.workspaceId ?? null,
      revision: captured?.revision ?? null,
      keyRevision: captured?.keyRevision ?? null,
      ...(captured?.mode === 'app'
        ? {
            appId: captured.appId,
            installationId: captured.installationId,
            fingerprint: captured.fingerprint,
          }
        : captured?.mode === 'token'
          ? { fingerprint: captured.fingerprint }
          : {}),
    },
    transport: { request },
    verifyRepositoryAuthority: async (repo) =>
      (
        await lease(
          repo,
          'repository-hooks-write',
          'effect',
          AbortSignal.timeout(GITHUB_APP_LIMITS.REQUEST_MS),
        )
      ).fence,
    repository: async (repository) => {
      const value = z
        .object({
          full_name: z.string(),
          private: z.boolean(),
          archived: z.boolean(),
          fork: z.boolean(),
          permissions: z.object({ admin: z.boolean() }).optional(),
        })
        .parse(await request({ operation: 'repository', repo: repository, intent: 'manage' }))
      return {
        nameWithOwner: value.full_name,
        visibility: value.private ? 'PRIVATE' : 'PUBLIC',
        isArchived: value.archived,
        isFork: value.fork,
        viewerPermission:
          options.mode === 'gh' ? (value.permissions?.admin ? 'ADMIN' : 'UNKNOWN') : null,
        hookAdministration: options.mode === 'app' || value.permissions?.admin === true,
      }
    },
  }
}

export function operatorGitHubExitCode(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return code === 'validation' ? 2 : code === 'ENOENT' ? 3 : 1
}
export function requireOperatorGitHubAuthentication(): never {
  const error = new GitHubAuthError('validation')
  error.message = OPERATOR_GITHUB_AUTH_USAGE
  throw error
}
