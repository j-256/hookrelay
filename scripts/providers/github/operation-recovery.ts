import { z } from 'zod'
import { configurationDigest, type ConfigurationQuery } from '../../../src/configuration/authority'
import {
  githubAuthQuery,
  githubAuthFencePredicate,
  readGitHubAuthDescriptor,
} from '../../../src/configuration/github-auth'
import {
  GITHUB_APP_LIMITS,
  GitHubAuthError,
  githubAuthId,
} from '../../../src/lib/github-app-contract'
import { parseGitHubHookRequest, type GitHubOperatorAuth } from './auth'
import {
  listGitHubRepositoryHooks,
  pingAndVerifyGitHubRepositoryHook,
  gitHubRepositoryHookSlug,
  sameGitHubEvents,
} from './repository-hooks'

const PAGE_SIZE = 100
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const recoverySchema = z
  .object({
    operationId: z.uuid(),
    expectedUpdatedAt: z.number().int().nonnegative(),
    requestHash: hash,
    originalRequest: z.unknown(),
    acknowledgeUncertainOutcome: z.literal(true),
    observation: z.enum(['present', 'absent']),
    expectedWebhookUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value)
        return (
          url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        )
      })
      .optional(),
  })
  .strict()
type Row = {
  id: string
  descriptor_id: string
  workspace_id: string
  repository_id: number
  operation: string
  hook_id: number | null
  request_hash: string
  state: string
  provider_status: number | null
  verified: number
  error_code: string | null
  updated_at: number
  created_at: number
  observation: string | null
}
function conflict(): never {
  throw new GitHubAuthError('conflict')
}
function selection(auth: GitHubOperatorAuth) {
  if (
    auth.metadata.mode === 'gh' ||
    !githubAuthId.safeParse(auth.metadata.descriptorId).success ||
    !githubAuthId.safeParse(auth.metadata.workspaceId).success
  )
    throw new GitHubAuthError('validation')
  return [auth.metadata.descriptorId!, auth.metadata.workspaceId!]
}
function metadata(row: Row) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    operation: row.operation,
    hookId: row.hook_id,
    requestHash: row.request_hash,
    historicalState: row.state,
    providerStatus: row.provider_status,
    verified: row.verified === 1,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    observation: row.observation,
  }
}
export async function inspectGitHubHookOperations(
  query: ConfigurationQuery,
  auth: GitHubOperatorAuth,
  input: { after?: string; all?: boolean },
) {
  const options = z
    .object({ after: z.uuid().optional(), all: z.boolean().optional() })
    .strict()
    .parse(input)
  const selected = selection(auth)
  const rows = await githubAuthQuery<Row>(
    query,
    `SELECT o.*,r.observation FROM github_hook_operations o LEFT JOIN github_hook_operation_reconciliations r ON r.operation_id=o.id
    WHERE o.descriptor_id=? AND o.workspace_id=? AND (?=1 OR (o.state IN ('prepared','submitting','indeterminate') AND r.operation_id IS NULL)) AND o.id>? ORDER BY o.id LIMIT ?`,
    [...selected, options.all ? 1 : 0, options.after ?? '', PAGE_SIZE + 1],
  )
  return {
    operations: rows.slice(0, PAGE_SIZE).map(metadata),
    next: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.id : null,
  }
}
async function reviewed(query: ConfigurationQuery, auth: GitHubOperatorAuth, input: unknown) {
  const parsed = recoverySchema.safeParse(input)
  if (!parsed.success) throw new GitHubAuthError('validation')
  const selected = selection(auth)
  const review = parsed.data
  const original = parseGitHubHookRequest(review.originalRequest)
  if (['list', 'repository', 'deliveries'].includes(original.operation))
    throw new GitHubAuthError('validation')
  const [row] = await githubAuthQuery<Row>(
    query,
    `SELECT o.*,r.observation FROM github_hook_operations o LEFT JOIN github_hook_operation_reconciliations r ON r.operation_id=o.id WHERE o.id=? AND o.descriptor_id=? AND o.workspace_id=?`,
    [review.operationId, ...selected],
  )
  if (
    !row ||
    row.observation ||
    row.request_hash !== review.requestHash ||
    row.updated_at !== review.expectedUpdatedAt ||
    row.operation !== original.operation ||
    !['prepared', 'submitting', 'indeterminate'].includes(row.state) ||
    row.updated_at > Date.now() - GITHUB_APP_LIMITS.REQUEST_MS ||
    (await configurationDigest(original)) !== row.request_hash
  )
    conflict()
  if (
    (original.operation === 'delete' && review.observation !== 'absent') ||
    (original.operation === 'ping' &&
      (review.observation !== 'present' || !review.expectedWebhookUrl))
  )
    throw new GitHubAuthError('validation')
  const descriptor = await readGitHubAuthDescriptor(query, {
    mode: auth.metadata.mode,
    descriptorId: auth.metadata.descriptorId!,
  })
  const repository = descriptor.repositories.find((repo) => repo.id === row.repository_id)
  if (!repository || !descriptor.managementWorkspaces.includes(auth.metadata.workspaceId!))
    conflict()
  return { review, original, row, repositoryName: repository.fullName }
}
export async function previewGitHubHookOperationRecovery(
  query: ConfigurationQuery,
  auth: GitHubOperatorAuth,
  input: unknown,
) {
  const { review, original, row, repositoryName } = await reviewed(query, auth, input)
  return {
    ...metadata(row),
    repository: original.repo,
    currentRepository: repositoryName,
    observation: review.observation,
    effects:
      review.observation === 'present'
        ? [
            'Read exact hook configuration',
            'Send and verify a fresh signed ping',
            'Record later observation; retain original outcome',
          ]
        : ['Read hook absence', 'Record later observation; retain original outcome'],
  }
}
export async function reconcileGitHubHookOperation(
  query: ConfigurationQuery,
  auth: GitHubOperatorAuth,
  input: unknown,
) {
  const { review, original, row, repositoryName } = await reviewed(query, auth, input)
  if (!auth.verifyRepositoryAuthority) throw new GitHubAuthError('unavailable')
  const observedAt = Date.now()
  const before = await auth.verifyRepositoryAuthority(repositoryName)
  if (before.repositoryId !== row.repository_id) conflict()
  const hooks = await listGitHubRepositoryHooks(repositoryName, auth.transport)
  let hookId: number | null = null
  let pingProof: unknown = null
  if (original.operation === 'delete') {
    if (hooks.some((hook) => hook.id === original.hookId)) conflict()
  } else {
    const expectedUrl = 'webhookUrl' in original ? original.webhookUrl : review.expectedWebhookUrl
    if (!expectedUrl) throw new GitHubAuthError('validation')
    const matches = hooks.filter(
      (hook) => new URL(hook.config.url).href === new URL(expectedUrl).href,
    )
    if (review.observation === 'absent') {
      if (
        matches.length ||
        ('hookId' in original && hooks.some((hook) => hook.id === original.hookId))
      )
        conflict()
    } else {
      if (matches.length !== 1) conflict()
      const hook = matches[0]!
      if (
        !gitHubRepositoryHookSlug(hook) ||
        ('hookId' in original && hook.id !== original.hookId) ||
        hook.active !== ('active' in original ? original.active : true) ||
        hook.config.content_type !== 'json' ||
        String(hook.config.insecure_ssl) !== '0' ||
        ('events' in original &&
          (!sameGitHubEvents(hook.events, original.events) ||
            ('active' in original && original.active !== hook.active)))
      )
        conflict()
      hookId = hook.id
      const ping = await pingAndVerifyGitHubRepositoryHook(repositoryName, hook.id, auth.transport)
      pingProof = { id: ping.id, statusCode: ping.statusCode, deliveredAt: ping.deliveredAt }
    }
  }
  const fence = await auth.verifyRepositoryAuthority(repositoryName)
  if (
    fence.repositoryId !== row.repository_id ||
    observedAt <= Date.now() - GITHUB_APP_LIMITS.AUTHORITY_AGE_MS
  )
    conflict()
  const guard = githubAuthFencePredicate(fence)
  const proof = {
    requestHash: review.requestHash,
    observation: review.observation,
    hookId,
    ping: pingProof,
    originalOutcomeRetained: true,
  }
  const inserted = await githubAuthQuery(
    query,
    `INSERT INTO github_hook_operation_reconciliations(operation_id,observation,hook_id,proof_json,auth_fence_json,observed_at,reconciled_at)
    SELECT id,?,?,?,?,?,? FROM github_hook_operations WHERE id=? AND descriptor_id=? AND workspace_id=? AND updated_at=? AND request_hash=? AND state IN ('prepared','submitting','indeterminate') AND (${guard.sql}) AND NOT EXISTS(SELECT 1 FROM github_hook_operation_reconciliations WHERE operation_id=github_hook_operations.id) RETURNING operation_id`,
    [
      review.observation,
      hookId,
      JSON.stringify(proof),
      JSON.stringify(fence),
      observedAt,
      Date.now(),
      row.id,
      ...selection(auth),
      review.expectedUpdatedAt,
      review.requestHash,
      ...guard.params,
    ],
  )
  if (!inserted.length) conflict()
  return {
    operationId: row.id,
    historicalState: row.state,
    observation: review.observation,
    hookId,
    observedAt,
    originalOutcomeRetained: true,
  }
}
