import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { configurationDigest, type ConfigurationQuery } from '../../../src/configuration/authority'
import {
  activateGitHubAuthCandidate,
  GITHUB_AUTH_REGISTRY_LIMITS,
  githubAuthQuery,
  prepareGitHubAuthCandidate,
  readGitHubAuthCandidate,
  type GitHubServingDeployment,
  type GitHubWorkerTarget,
} from '../../../src/configuration/github-auth'
import {
  githubAuthDescriptorSchema,
  GITHUB_APP_LIMITS,
  githubAuthSecretName,
  GitHubAuthError,
  type GitHubAuthDescriptor,
} from '../../../src/lib/github-app-contract'
import { verifyGitHubInstallation, readGitHubAppJson } from '../../../src/lib/github-app-token'
import {
  createGitHubAppKeyChallenge,
  GITHUB_APP_KEY_VERIFICATION_PATH,
} from '../../../src/management/github-app-key-verification'
import { readGitHubCredentialPrivateFile, type GitHubCredentialRecoveryFile } from './app-private-file'
import { githubAuthIdentity, recordGitHubAuthResponse } from '../../../src/lib/github-auth'
import { fetchGitHubWithDeadline } from '../../../src/lib/github-http'
import { assertGitHubAuthCooldown, recordGitHubAuthCooldown } from '../../../src/configuration/github-auth'

export type GitHubWorkerIdentity = { target: GitHubWorkerTarget; databaseId: string; configDigest: string }
export type GitHubWorkerVersion = {
  id: string
  scriptEtag: string
  runtimeDigest: string
  bindings: { name: string; type: string; id?: string; digest?: string }[]
  tag?: string
}
export interface GitHubAppDeploymentProvider {
  latestVersion(): Promise<GitHubWorkerVersion>
  version(id: string): Promise<GitHubWorkerVersion>
  stage(name: string, key: string, tag: string): Promise<string>
  taggedVersions(tag: string): Promise<GitHubWorkerVersion[]>
  deployment(): Promise<GitHubServingDeployment>
  deploy(id: string): Promise<void>
}
export type GitHubAppDeploymentInput = GitHubWorkerIdentity & {
  descriptor: GitHubAuthDescriptor
  expectedRevision: number
  baseVersionId: string
  verificationOrigin: string
}
export type GitHubAppDeploymentPlan = GitHubAppDeploymentInput & {
  candidateId: string
  baseVersion: GitHubWorkerVersion
}
export type GitHubAppStageReceipt = {
  candidateId: string
  phase: string
  versionId: string | null
  attestationId: string | null
}
export type GitHubAppDeploymentReceipt = GitHubAppStageReceipt
export type GitHubAppDeploymentAttestation = GitHubAppStageReceipt
export type GitHubAppDeploymentDependencies = {
  query: ConfigurationQuery
  provider: GitHubAppDeploymentProvider
  recoveryFile: string
  currentIdentity(): Promise<GitHubWorkerIdentity>
  verifyMaterial?: (recovery: GitHubCredentialRecoveryFile, descriptor: GitHubAuthDescriptor) => Promise<void>
  fetch?: typeof fetch
}
const identitySchema = z.object({
  target: z.object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    workerName: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/),
  }),
  databaseId: z.uuid(),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
const inputSchema = identitySchema
  .extend({
    descriptor: githubAuthDescriptorSchema,
    expectedRevision: z.number().int().nonnegative(),
    baseVersionId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9_-]+$/),
    verificationOrigin: z.url().refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value
    }),
  })
  .strict()
const versionSchema = z
  .object({
    id: z.string().min(1).max(160),
    scriptEtag: z.string().min(1).max(200),
    runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/),
    bindings: z
      .array(
        z
          .object({
            name: z.string().max(160),
            type: z.string().max(80),
            id: z.string().max(160).optional(),
            digest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(500),
    tag: z.string().max(160).optional(),
  })
  .strict()
const planSchema = inputSchema.extend({ candidateId: z.uuid(), baseVersion: versionSchema }).strict()
const equal = async (a: unknown, b: unknown) => (await configurationDigest(a)) === (await configurationDigest(b))
function conflict(): never {
  throw new GitHubAuthError('conflict')
}
function identity(plan: GitHubWorkerIdentity) {
  return { target: plan.target, databaseId: plan.databaseId, configDigest: plan.configDigest }
}
function compatible(version: GitHubWorkerVersion, databaseId: string) {
  return (
    version.bindings.filter(
      (binding) => binding.name === 'EVENTS_DB' && binding.type === 'd1' && binding.id === databaseId,
    ).length === 1 &&
    version.bindings.some((binding) => binding.name === 'CF_VERSION_METADATA' && binding.type === 'version_metadata')
  )
}
async function material(deps: GitHubAppDeploymentDependencies, descriptor: GitHubAuthDescriptor) {
  const recovery = await readGitHubCredentialPrivateFile(deps.recoveryFile)
  if (descriptor.mode==='gh' || recovery.fingerprint!==descriptor.fingerprint)conflict()
  if (descriptor.mode==='app' && (recovery.kind!=='github-app' || recovery.app.id!==descriptor.appId || descriptor.repositories.some(repo=>repo.ownerId!==descriptor.accountId)))conflict()
  if (descriptor.mode==='token' && recovery.kind!=='github-token')conflict()
  return recovery
}
export async function prepareGitHubAppDeployment(
  input: GitHubAppDeploymentInput,
  deps: GitHubAppDeploymentDependencies,
): Promise<GitHubAppDeploymentPlan> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success || parsed.data.descriptor.mode === 'gh' || parsed.data.descriptor.state !== 'active')
    throw new GitHubAuthError('validation')
  input = parsed.data
  if (!(await equal(identity(input), await deps.currentIdentity()))) conflict()
  const [prior] = await githubAuthQuery<{ revision: number; key_revision: number; metadata_json:string }>(
    deps.query,
    'SELECT revision,key_revision,metadata_json FROM github_auth_descriptors WHERE id=?',
    [input.descriptor.id],
  )
  if (
    (prior?.revision ?? 0) !== input.expectedRevision ||
    input.descriptor.keyRevision !== (prior?.key_revision ?? 0) + 1
  )
    conflict()
  const recovery = await material(deps, input.descriptor)
  const baseVersion = await deps.provider.latestVersion()
  if (
    baseVersion.id !== input.baseVersionId ||
    !compatible(baseVersion, input.databaseId) ||
    baseVersion.bindings.some(
      (binding) => binding.name === githubAuthSecretName(input.descriptor),
    )
  )
    conflict()
  await assertRetainedCredentials(deps.query,baseVersion)
  if (deps.verifyMaterial) await deps.verifyMaterial(recovery, input.descriptor)
  else await verifyMaterialScope(recovery,input.descriptor,deps)
  const candidate = await prepareGitHubAuthCandidate(deps.query, {
    descriptor: input.descriptor,
    expectedRevision: input.expectedRevision,
    target: input.target,
  })
  const plan = planSchema.parse({ ...input, candidateId: candidate.id, baseVersion })
  await githubAuthQuery(
    deps.query,
    "INSERT INTO github_app_deployments(candidate_id,plan_json,phase,updated_at) VALUES (?,?,'prepared',?)",
    [candidate.id, JSON.stringify(plan), Date.now()],
  )
  return plan
}
async function journal(deps: GitHubAppDeploymentDependencies, id: string) {
  const candidate = await readGitHubAuthCandidate(deps.query, id)
  const [row] = await githubAuthQuery<{
    plan_json: string
    phase: string
    version_id: string | null
    attestation_id: string | null
  }>(deps.query, 'SELECT * FROM github_app_deployments WHERE candidate_id=?', [id])
  if (
    !row ||
    (candidate.state !== 'active' && candidate.expiresAt <= Date.now()) ||
    candidate.descriptor.mode === 'gh'
  )
    conflict()
  let plan: GitHubAppDeploymentPlan
  try {
    plan = planSchema.parse(JSON.parse(row.plan_json))
  } catch {
    throw new GitHubAuthError('unavailable')
  }
  if (
    plan.candidateId !== id ||
    !(await equal(plan.descriptor, candidate.descriptor)) ||
    !(await equal(identity(plan), await deps.currentIdentity()))
  )
    conflict()
  await material(deps, candidate.descriptor)
  if (
    candidate.state !== 'active' &&
    !(
      await githubAuthQuery(
        deps.query,
        `SELECT 1 FROM github_auth_candidates c WHERE c.id=? AND COALESCE((SELECT revision FROM github_auth_descriptors WHERE id=c.descriptor_id),0)=c.prior_revision AND (SELECT revision FROM github_auth_runtime_policy WHERE id=1)=c.prior_policy_revision`,
        [id],
      )
    ).length
  )
    conflict()
  return { candidate, plan, row }
}
function receipt(
  id: string,
  row: { phase: string; version_id: string | null; attestation_id: string | null },
): GitHubAppStageReceipt {
  return { candidateId: id, phase: row.phase, versionId: row.version_id, attestationId: row.attestation_id }
}
async function save(
  deps: GitHubAppDeploymentDependencies,
  id: string,
  phase: string,
  versionId: string | null,
  attestationId: string | null = null,
) {
  await githubAuthQuery(
    deps.query,
    'UPDATE github_app_deployments SET phase=?,version_id=?,attestation_id=?,updated_at=? WHERE candidate_id=?',
    [phase, versionId, attestationId, Date.now(), id],
  )
  return { candidateId: id, phase, versionId, attestationId }
}
async function validateStaged(plan: GitHubAppDeploymentPlan, version: GitHubWorkerVersion,query:ConfigurationQuery) {
  await assertRetainedCredentials(query,version)
  if (
    plan.descriptor.mode === 'gh' ||
    version.scriptEtag !== plan.baseVersion.scriptEtag ||
    version.runtimeDigest !== plan.baseVersion.runtimeDigest ||
    !compatible(version, plan.databaseId)
  )
    conflict()
  const expected = [...plan.baseVersion.bindings, { name: githubAuthSecretName(plan.descriptor), type: 'secret_text' }].sort(
    (a, b) => a.name.localeCompare(b.name),
  )
  if (
    !(await equal(
      [...version.bindings].sort((a, b) => a.name.localeCompare(b.name)),
      expected,
    ))
  )
    conflict()
}
export async function stageGitHubAppWorkerKey(
  id: string,
  deps: GitHubAppDeploymentDependencies,
): Promise<GitHubAppStageReceipt> {
  const { candidate, plan, row } = await journal(deps, id)
  if (['staged', 'deployed', 'verified'].includes(row.phase)) return receipt(id, row)
  if (['stage_intent', 'stage_indeterminate'].includes(row.phase)) {
    const versions = await deps.provider.taggedVersions(id)
    if (versions.length !== 1) return save(deps, id, 'stage_indeterminate', null)
    await validateStaged(plan, versions[0]!,deps.query)
    await githubAuthQuery(
      deps.query,
      "UPDATE github_auth_candidates SET state='staged',version_id=? WHERE id=? AND state='prepared'",
      [versions[0]!.id, id],
    )
    return save(deps, id, 'staged', versions[0]!.id)
  }
  if (
    row.phase !== 'prepared' ||
    candidate.state !== 'prepared' ||
    (await deps.provider.latestVersion()).id !== plan.baseVersionId
  )
    conflict()
  const claimed = await githubAuthQuery(
    deps.query,
    `UPDATE github_app_deployments SET phase='stage_intent',updated_at=? WHERE candidate_id=? AND phase='prepared'
    AND EXISTS(SELECT 1 FROM github_auth_candidates c WHERE c.id=candidate_id AND c.expires_at>? AND COALESCE((SELECT revision FROM github_auth_descriptors WHERE id=c.descriptor_id),0)=c.prior_revision AND (SELECT revision FROM github_auth_runtime_policy WHERE id=1)=c.prior_policy_revision) RETURNING candidate_id`,
    [Date.now(), id, Date.now()],
  )
  if (!claimed.length || candidate.descriptor.mode === 'gh') conflict()
  const recovery = await material(deps, candidate.descriptor)
  let versionId: string
  try {
    versionId = await deps.provider.stage(githubAuthSecretName(candidate.descriptor), recovery.kind==='github-app' ? recovery.privateKey : recovery.token, id)
  } catch {
    return save(deps, id, 'stage_indeterminate', null)
  }
  try {
    await validateStaged(plan, await deps.provider.version(versionId),deps.query)
  } catch {
    await save(deps, id, 'conflict', versionId)
    conflict()
  }
  await githubAuthQuery(
    deps.query,
    "UPDATE github_auth_candidates SET state='staged',version_id=? WHERE id=? AND state='prepared'",
    [versionId, id],
  )
  return save(deps, id, 'staged', versionId)
}
export async function deployGitHubAppWorkerVersion(
  id: string,
  deps: GitHubAppDeploymentDependencies,
): Promise<GitHubAppDeploymentReceipt> {
  const { plan, row } = await journal(deps, id)
  if (
    !row.version_id ||
    !['staged', 'deploy_intent', 'deployment_indeterminate', 'deployed', 'verified'].includes(row.phase)
  )
    conflict()
  await validateStaged(plan, await deps.provider.version(row.version_id),deps.query)
  const serving = await deps.provider.deployment()
  if (serving.singleVersion && serving.versionId === row.version_id) {
    await githubAuthQuery(
      deps.query,
      "UPDATE github_auth_candidates SET state='deployed' WHERE id=? AND state IN ('staged','deployment_indeterminate')",
      [id],
    )
    return save(deps, id, 'deployed', row.version_id)
  }
  if (row.phase !== 'staged') return save(deps, id, 'deployment_indeterminate', row.version_id)
  const claimed = await githubAuthQuery(
    deps.query,
    "UPDATE github_app_deployments SET phase='deploy_intent',updated_at=? WHERE candidate_id=? AND phase='staged' RETURNING candidate_id",
    [Date.now(), id],
  )
  if (!claimed.length) conflict()
  await journal(deps, id)
  try {
    await deps.provider.deploy(row.version_id)
  } catch {
    return save(deps, id, 'deployment_indeterminate', row.version_id)
  }
  const observed = await deps.provider.deployment()
  if (!observed.singleVersion || observed.versionId !== row.version_id)
    return save(deps, id, 'deployment_indeterminate', row.version_id)
  await githubAuthQuery(
    deps.query,
    "UPDATE github_auth_candidates SET state='deployed' WHERE id=? AND state='staged'",
    [id],
  )
  return save(deps, id, 'deployed', row.version_id)
}
export async function verifyGitHubAppWorkerKey(
  id: string,
  deps: GitHubAppDeploymentDependencies,
): Promise<GitHubAppDeploymentAttestation> {
  const { plan, row } = await journal(deps, id)
  const serving = await deps.provider.deployment()
  if (
    !row.version_id ||
    !['deployed', 'verified'].includes(row.phase) ||
    !serving.singleVersion ||
    serving.versionId !== row.version_id ||
    !(await equal(plan.target, { accountId: serving.accountId, workerName: serving.workerName })) ||
    plan.descriptor.mode === 'gh'
  )
    conflict()
  await validateStaged(plan, await deps.provider.version(row.version_id),deps.query)
  const challenge = await createGitHubAppKeyChallenge(deps.query, id, row.version_id)
  const signal = AbortSignal.timeout(8000)
  let value: { attestationId: string; versionId: string; fingerprint: string }
  try {
    const response = await (deps.fetch ?? fetch)(plan.verificationOrigin + GITHUB_APP_KEY_VERIFICATION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: challenge.nonce }),
      signal,
      redirect: 'error',
    })
    if (!response.ok) throw new Error()
    value = z
      .object({ attestationId: z.uuid(), versionId: z.string(), fingerprint: z.string() })
      .strict()
      .parse(await readGitHubAppJson(response, signal))
  } catch {
    throw new GitHubAuthError('unavailable')
  }
  if (value.versionId !== row.version_id || value.fingerprint !== plan.descriptor.fingerprint) conflict()
  if (
    !(
      await githubAuthQuery(
        deps.query,
        `SELECT id FROM github_auth_attestations WHERE id=? AND candidate_id=? AND account_id=? AND worker_name=? AND version_id=? AND fingerprint=? AND expires_at>? AND consumed_at IS NULL`,
        [
          value.attestationId,
          id,
          plan.target.accountId,
          plan.target.workerName,
          row.version_id,
          value.fingerprint,
          Date.now(),
        ],
      )
    ).length
  )
    conflict()
  await githubAuthQuery(
    deps.query,
    "UPDATE github_auth_candidates SET state='verified' WHERE id=? AND state IN ('deployed','verified')",
    [id],
  )
  return save(deps, id, 'verified', row.version_id, value.attestationId)
}
export async function activateGitHubAppDeployment(id: string, deps: GitHubAppDeploymentDependencies) {
  const { plan, row } = await journal(deps, id)
  if (row.phase !== 'verified' || !row.attestation_id) conflict()
  return activateGitHubAuthCandidate(deps.query, {
    candidateId: id,
    attestationId: row.attestation_id,
    verifyDeployment: async () => {
      if (!row.version_id) conflict()
      await validateStaged(plan, await deps.provider.version(row.version_id),deps.query)
      const serving = await deps.provider.deployment()
      if (serving.versionId !== row.version_id || !serving.singleVersion) conflict()
      return serving
    },
  })
}
export async function readGitHubWorkerIdentity(
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<GitHubWorkerIdentity> {
  try {
    const text = await readFile(configPath, 'utf8')
    const errors: ParseError[] = []
    const config = z
      .object({
        name: z.string(),
        account_id: z.string().optional(),
        d1_databases: z.array(z.object({ binding: z.string(), database_id: z.uuid() })),
        version_metadata: z.object({ binding: z.literal('CF_VERSION_METADATA') }),
      })
      .parse(parseJsonc(text, errors, { allowTrailingComma: true }))
    const databases = config.d1_databases.filter((binding) => binding.binding === 'EVENTS_DB')
    if (
      errors.length ||
      databases.length !== 1 ||
      (config.account_id && config.account_id !== environment.CLOUDFLARE_ACCOUNT_ID)
    )
      throw new Error()
    return identitySchema.parse({
      target: { accountId: environment.CLOUDFLARE_ACCOUNT_ID, workerName: config.name },
      databaseId: databases[0]!.database_id,
      configDigest: createHash('sha256').update(text).digest('hex'),
    })
  } catch {
    throw new GitHubAuthError('validation')
  }
}
export function createGitHubAppDeploymentProvider(
  target: GitHubWorkerTarget,
  environment: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): GitHubAppDeploymentProvider {
  const token = environment.CLOUDFLARE_API_TOKEN
  if (!token || !/^[a-f0-9]{32}$/.test(target.accountId) || !/^[A-Za-z0-9_-]{1,63}$/.test(target.workerName))
    throw new GitHubAuthError('validation')
  const prefix = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers`
  async function request(path: string, method = 'GET', body?: unknown) {
    try {
      const signal = AbortSignal.timeout(15000)
      const response = await fetcher(prefix + path, {
        method,
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json',
        },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error()
      }
      const parsed = z
        .object({ success: z.literal(true), result: z.unknown() })
        .parse(await readGitHubAppJson(response, signal))
      return parsed.result
    } catch {
      throw new GitHubAuthError('unavailable')
    }
  }
  const script = `/scripts/${target.workerName}`
  async function version(id: string): Promise<GitHubWorkerVersion> {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) conflict()
    try {
      const raw = z
        .object({
          id: z.string(),
          annotations: z.record(z.string(), z.string()).optional(),
          resources: z.object({
            script: z.object({ etag: z.string() }),
            script_runtime: z.unknown(),
            bindings: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()).max(500),
          }),
        })
        .parse(await request(script + '/versions/' + id))
      if (raw.id !== id) conflict()
      const bindings = await Promise.all(
        raw.resources.bindings.map(async (binding) =>
          binding.type === 'secret_text'
            ? { name: binding.name, type: binding.type }
            : {
                name: binding.name,
                type: binding.type,
                ...(binding.type === 'd1' ? { id: z.string().parse(binding.id) } : {}),
                digest: await configurationDigest(binding),
              },
        ),
      )
      return versionSchema.parse({
        id: raw.id,
        scriptEtag: raw.resources.script.etag,
        runtimeDigest: await configurationDigest(raw.resources.script_runtime),
        bindings,
        ...(raw.annotations?.['workers/tag'] ? { tag: raw.annotations!['workers/tag'] } : {}),
      })
    } catch (error) {
      if (error instanceof GitHubAuthError) throw error
      throw new GitHubAuthError('unavailable')
    }
  }
  return {
    version,
    latestVersion: async () => {
      const { id } = z.object({ id: z.string() }).parse(await request(`/workers/${target.workerName}/versions/latest`))
      return version(id)
    },
    stage: async (name, key, tag) => {
      if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(name) || !/^[A-Za-z0-9_-]{1,160}$/.test(tag))
        throw new GitHubAuthError('validation')
      const result = await request(`/workers/${target.workerName}/versions/latest`, 'PATCH', {
        env: { [name]: { type: 'secret_text', text: key } },
        annotations: { 'workers/message': 'Stage reviewed GitHub credential', 'workers/tag': tag },
      })
      return z.object({ id: z.string().min(1) }).parse(result).id
    },
    taggedVersions: async (tag) => {
      const result = z
        .object({
          items: z
            .array(z.object({ id: z.string(), annotations: z.record(z.string(), z.string()).optional() }))
            .max(100),
        })
        .parse(await request(script + '/versions?per_page=100'))
      const matches = result.items.filter((item) => item.annotations?.['workers/tag'] === tag)
      if (matches.length > 1) conflict()
      return Promise.all(matches.map((item) => version(item.id)))
    },
    deployment: async () => {
      const result = z
        .object({
          deployments: z
            .array(
              z.object({
                created_on: z.string(),
                versions: z.array(z.object({ version_id: z.string(), percentage: z.number() })),
              }),
            )
            .max(100),
        })
        .parse(await request(script + '/deployments'))
      const current = result.deployments.sort((a, b) => b.created_on.localeCompare(a.created_on))[0]
      const versions = current?.versions.filter((value) => value.percentage > 0) ?? []
      return {
        ...target,
        versionId: versions.length === 1 ? versions[0]!.version_id : '',
        singleVersion: versions.length === 1 && versions[0]!.percentage === 100,
      }
    },
    deploy: async (id) => {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new GitHubAuthError('validation')
      await request(script + '/deployments', 'POST', {
        strategy: 'percentage',
        versions: [{ version_id: id, percentage: 100 }],
        annotations: { 'workers/message': 'Deploy reviewed GitHub credential version' },
      })
    },
  }
}
export async function previewGitHubAppDeployment(id: string, deps: GitHubAppDeploymentDependencies) {
  const { plan, row } = await journal(deps, id)
  return {
    ...receipt(id, row),
    target: plan.target,
    databaseId: plan.databaseId,
    descriptorId: plan.descriptor.id,
    revision: plan.descriptor.revision,
    fingerprint: plan.descriptor.mode !== 'gh' ? plan.descriptor.fingerprint : null,
    baseVersionId: plan.baseVersionId,
    scriptEtag: plan.baseVersion.scriptEtag,
  }
}
export async function readGitHubAppOperatorStatus(query: ConfigurationQuery, descriptorId: string) {
  const [row] = await githubAuthQuery<{ metadata_json: string }>(
    query,
    'SELECT metadata_json FROM github_auth_descriptors WHERE id=?',
    [descriptorId],
  )
  if (!row) throw new GitHubAuthError('unavailable')
  let descriptor: GitHubAuthDescriptor
  try {
    descriptor = githubAuthDescriptorSchema.parse(JSON.parse(row.metadata_json))
  } catch {
    throw new GitHubAuthError('unavailable')
  }
  return {
    descriptorId: descriptor.id,
    mode: descriptor.mode,
    revision: descriptor.revision,
    keyRevision: descriptor.keyRevision,
    state: descriptor.state,
    repositoryNames: descriptor.repositories.map((repo) => repo.fullName),
    managementWorkspaces: descriptor.managementWorkspaces,
  }
}
export async function disconnectGitHubAppDescriptor(query: ConfigurationQuery, descriptorId: string, revision: number) {
  const status = await readGitHubAppOperatorStatus(query, descriptorId)
  if (status.state === 'disconnected' && status.revision === revision) return status
  const rows = await githubAuthQuery(
    query,
    `UPDATE github_auth_descriptors SET revision=revision+1,metadata_json=json_set(metadata_json,'$.state','disconnected','$.revision',revision+1),write_id=? WHERE id=? AND revision=? AND json_extract(metadata_json,'$.state')='active' RETURNING id`,
    [crypto.randomUUID(), descriptorId, revision],
  )
  if (!rows.length) conflict()
  return readGitHubAppOperatorStatus(query, descriptorId)
}

async function verifyMaterialScope(recovery:GitHubCredentialRecoveryFile,descriptor:GitHubAuthDescriptor,deps:GitHubAppDeploymentDependencies) {
  const capability=descriptor.capabilities.includes('repository-hooks-write') ? 'repository-hooks-write' : 'repository-hooks-read'
  const {quotaKey}=await githubAuthIdentity(descriptor,0,descriptor.managementWorkspaces[0]!,'cloudflare-operator',descriptor.repositories[0]!.id,capability)
  await assertGitHubAuthCooldown(deps.query,quotaKey,Date.now())
  const signal=AbortSignal.timeout(GITHUB_APP_LIMITS.REQUEST_MS)
  const fetcher:typeof fetch=async (url,init) => {
    if(typeof url!=='string')throw new GitHubAuthError('validation')
    const response=await fetchGitHubWithDeadline(deps.fetch ?? fetch,url,{...init,signal})
    await recordGitHubAuthResponse(deps.query,quotaKey,response)
    return response
  }
  try {
    if(descriptor.mode==='app' && recovery.kind==='github-app') {
      await verifyGitHubInstallation({...descriptor,privateKey:recovery.privateKey,capability,fetch:fetcher,signal})
    } else if(descriptor.mode==='token' && recovery.kind==='github-token') {
      for(const repo of descriptor.repositories) {
        if(['.','..'].includes(repo.fullName.split('/')[1]!))throw new GitHubAuthError('validation')
        const response=await fetcher('https://api.github.com/repos/'+repo.fullName,{method:'GET',redirect:'manual',signal,headers:{authorization:'Bearer '+recovery.token,accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'Hookrelay'}})
        if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new GitHubAuthError('denied')}
        const value=z.object({id:z.number(),full_name:z.string(),owner:z.object({id:z.number()}),private:z.boolean()}).parse(await readGitHubAppJson(response,signal))
        if(value.id!==repo.id || value.full_name!==repo.fullName || value.owner.id!==repo.ownerId || value.private!==repo.private)throw new GitHubAuthError('denied')
      }
    } else throw new GitHubAuthError('validation')
  } catch(error) {
    if(error instanceof GitHubAuthError && error.code==='rate_limited')await recordGitHubAuthCooldown(deps.query,quotaKey,error.retryAt ?? Date.now()+GITHUB_APP_LIMITS.AUTHORITY_AGE_MS)
    if(error instanceof GitHubAuthError)throw error
    throw new GitHubAuthError('unavailable')
  }
}

async function assertRetainedCredentials(query:ConfigurationQuery,version:GitHubWorkerVersion) {
  const rows=await githubAuthQuery<{metadata_json:string}>(query,"SELECT metadata_json FROM github_auth_descriptors WHERE json_extract(metadata_json,'$.state')='active' ORDER BY id LIMIT ?",[GITHUB_AUTH_REGISTRY_LIMITS.DESCRIPTORS+1])
  if(rows.length>GITHUB_AUTH_REGISTRY_LIMITS.DESCRIPTORS)conflict()
  for(const row of rows) {
    const descriptor=githubAuthDescriptorSchema.parse(JSON.parse(row.metadata_json))
    if(descriptor.mode!=='gh' && !version.bindings.some(binding=>binding.type==='secret_text' && binding.name===githubAuthSecretName(descriptor)))conflict()
  }
}
