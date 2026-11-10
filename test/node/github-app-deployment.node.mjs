import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  normalizeGitHubAppPrivateKey,
  writeNewGitHubAppPrivateFile,
} from '../../scripts/providers/github/app-private-file.ts'
import {
  prepareGitHubAppDeployment,
  stageGitHubAppWorkerKey,
  deployGitHubAppWorkerVersion,
  verifyGitHubAppWorkerKey,
  activateGitHubAppDeployment,
} from '../../scripts/providers/github/app-deployment.ts'
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const normalized = normalizeGitHubAppPrivateKey(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'hookrelay-app-deploy-'))
  const db = new DatabaseSync(':memory:')
  try {
    for (const file of ['0012_github_app_auth.sql', '0013_github_app_deployment.sql'])
      db.exec(await readFile(join('migrations', file), 'utf8'))
    const query = async ({ sql, params }) => db.prepare(sql).all(...params)
    const recoveryFile = join(root, 'recovery.json')
    await writeNewGitHubAppPrivateFile(recoveryFile, {
      version: 1,
      kind: 'github-app',
      app: { id: 42, slug: 'provider-app', ownerId: 50, ownerLogin: 'example', ownerType: 'Organization' },
      privateKey: normalized.pkcs8,
      fingerprint: normalized.fingerprint,
      createdAt: new Date().toISOString(),
    })
    const target = { accountId: 'a'.repeat(32), workerName: 'synthetic-worker' }
    const identity = { target, databaseId: '11111111-1111-4111-8111-111111111111', configDigest: 'b'.repeat(64) }
    const bindings = [
      { type: 'd1', name: 'EVENTS_DB', id: identity.databaseId },
      { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
      { type: 'secret_text', name: 'GITHUB_APP_KEY_OLD' },
    ]
    const versions = new Map([
      ['version-base', { id: 'version-base', scriptEtag: 'script-a', runtimeDigest: 'c'.repeat(64), bindings }],
    ])
    const state = {
      stages: 0,
      deploys: 0,
      lost: false,
      split: false,
      version: 'version-old',
      latest: 'version-base',
      changedConfig: false,
      changedStage: false,
    }
    const provider = {
      latestVersion: async () => versions.get(state.latest),
      version: async (id) => versions.get(id),
      stage: async (name, key, tag) => {
        state.stages++
        assert.equal(key, normalized.pkcs8)
        const version = {
          ...versions.get('version-base'),
          id: 'version-staged',
          tag,
          scriptEtag: state.changedStage ? 'unreviewed-code' : 'script-a',
          bindings: [...bindings, { type: 'secret_text', name }],
        }
        versions.set(version.id, version)
        state.latest = version.id
        return version.id
      },
      deployment: async () => ({ ...target, versionId: state.version, singleVersion: !state.split }),
      deploy: async (versionId) => {
        state.deploys++
        state.version = versionId
        if (state.lost) throw new Error('private-deploy-error')
      },
      taggedVersions: async (tag) => [...versions.values()].filter((version) => version.tag === tag),
    }
    const deps = {
      query,
      provider,
      recoveryFile,
      currentIdentity: async () => ({
        ...identity,
        configDigest: state.changedConfig ? 'd'.repeat(64) : identity.configDigest,
      }),
      verifyMaterial: async () => {},
      fetch: async (_url, init) => {
        const { nonce } = JSON.parse(init.body)
        assert.equal(typeof nonce, 'string')
        const attestationId = crypto.randomUUID()
        const candidate = db.prepare('SELECT id FROM github_auth_candidates ORDER BY created_at DESC LIMIT 1').get()
        db.prepare(
          'INSERT INTO github_auth_attestations(id,candidate_id,account_id,worker_name,version_id,fingerprint,verified_at,expires_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          attestationId,
          candidate.id,
          target.accountId,
          target.workerName,
          state.version,
          normalized.fingerprint,
          Date.now(),
          Date.now() + 60000,
        )
        return Response.json({ attestationId, versionId: state.version, fingerprint: normalized.fingerprint })
      },
    }
    const descriptor = {
      id: 'app',
      revision: 1,
      keyRevision: 1,
      mode: 'app',
      appId: 42,
      installationId: 7,
      accountId: 50,
      keySecretName: 'GITHUB_APP_KEY_NEW',
      fingerprint: normalized.fingerprint,
      repositories: [{ id: 101, fullName: 'example/allowed', ownerId: 50, private: true }],
      managementWorkspaces: ['alpha'],
      capabilities: ['repository-hooks-write'],
      state: 'active',
    }
    const input = {
      ...identity,
      descriptor,
      expectedRevision: 0,
      baseVersionId: 'version-base',
      verificationOrigin: 'https://hooks.example',
    }
    await run({ root, db, query, recoveryFile, descriptor, input, deps, state, versions })
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
}
test('stages a retained key without deploying and activates only an exact attested serving version', async () =>
  fixture(async (f) => {
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    assert.equal(f.state.stages, 0)
    assert.equal(f.state.deploys, 0)
    const staged = await stageGitHubAppWorkerKey(plan.candidateId, f.deps)
    assert.equal(staged.phase, 'staged')
    assert.equal(f.state.deploys, 0)
    assert.equal(
      f.versions.get('version-staged').bindings.some((binding) => binding.name === 'GITHUB_APP_KEY_OLD'),
      true,
    )
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM github_auth_descriptors').get().n, 0)
    const deployed = await deployGitHubAppWorkerVersion(plan.candidateId, f.deps)
    assert.equal(deployed.phase, 'deployed')
    assert.equal(f.state.deploys, 1)
    f.state.split = true
    await assert.rejects(verifyGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'conflict' })
    f.state.split = false
    const verified = await verifyGitHubAppWorkerKey(plan.candidateId, f.deps)
    assert.equal(verified.phase, 'verified')
    f.state.version = 'changed'
    await assert.rejects(activateGitHubAppDeployment(plan.candidateId, f.deps), { code: 'conflict' })
    f.state.version = 'version-staged'
    assert.equal((await activateGitHubAppDeployment(plan.candidateId, f.deps)).state, 'active')
    assert.equal(f.db.prepare('SELECT mode FROM github_auth_runtime_policy').get().mode, 'registry')
    assert.equal(JSON.stringify(plan).includes('PRIVATE KEY'), false)
  }))
test('reconciles a lost deployment response without dispatching another deployment', async () =>
  fixture(async (f) => {
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    await stageGitHubAppWorkerKey(plan.candidateId, f.deps)
    f.state.lost = true
    assert.equal((await deployGitHubAppWorkerVersion(plan.candidateId, f.deps)).phase, 'deployment_indeterminate')
    assert.equal((await deployGitHubAppWorkerVersion(plan.candidateId, f.deps)).phase, 'deployed')
    assert.equal(f.state.deploys, 1)
    assert.equal(f.state.stages, 1)
  }))
test('rejects changed config, unreviewed staged code, old secret name reuse and stale revision before effects', async () =>
  fixture(async (f) => {
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    f.state.changedConfig = true
    await assert.rejects(stageGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'conflict' })
    assert.equal(f.state.stages, 0)
    f.state.changedConfig = false
    f.state.changedStage = true
    await assert.rejects(stageGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'conflict' })
    assert.equal(f.state.deploys, 0)
    await assert.rejects(
      prepareGitHubAppDeployment(
        { ...f.input, descriptor: { ...f.descriptor, keySecretName: 'GITHUB_APP_KEY_OLD' } },
        f.deps,
      ),
      { code: 'conflict' },
    )
  }))
test('retains a stage intent and reconciles its unique version after a lost upload result', async () =>
  fixture(async (f) => {
    const stage = f.deps.provider.stage
    f.deps.provider.stage = async (...args) => {
      await stage(...args)
      throw new Error('private-key-canary')
    }
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    assert.equal((await stageGitHubAppWorkerKey(plan.candidateId, f.deps)).phase, 'stage_indeterminate')
    assert.equal((await stageGitHubAppWorkerKey(plan.candidateId, f.deps)).phase, 'staged')
    assert.equal(f.state.stages, 1)
  }))
test('uses fixed provider endpoints and protected fetch bodies for staging without a hidden deployment', async () => {
  const { createGitHubAppDeploymentProvider } = await import('../../scripts/providers/github/app-deployment.ts')
  const target = { accountId: 'a'.repeat(32), workerName: 'worker' }
  const requests = []
  const provider = createGitHubAppDeploymentProvider(
    target,
    { CLOUDFLARE_API_TOKEN: 'synthetic-cf-token' },
    async (url, init) => {
      requests.push({ url: String(url), method: init.method, body: init.body })
      assert.equal(new URL(url).origin, 'https://api.cloudflare.com')
      assert.equal(init.redirect, 'error')
      if (init.method === 'PATCH') return Response.json({ success: true, result: { id: 'new-version' } })
      if (String(url).endsWith('/versions/latest'))
        return Response.json({ success: true, result: { id: 'base-version' } })
      return Response.json({
        success: true,
        result: {
          id: 'base-version',
          resources: {
            script: { etag: 'code-a' },
            script_runtime: { compatibility_date: '2026-06-01' },
            bindings: [
              { type: 'd1', name: 'EVENTS_DB', id: 'database' },
              { type: 'plain_text', name: 'PRIVATE_SETTING', text: 'private-setting-canary' },
              { type: 'secret_text', name: 'OLD_SECRET' },
            ],
          },
        },
      })
    },
  )
  const version = await provider.latestVersion()
  assert.equal(JSON.stringify(version).includes('private-setting-canary'), false)
  assert.equal(await provider.stage('GITHUB_APP_KEY_NEW', normalized.pkcs8, 'candidate-tag'), 'new-version')
  assert.equal(requests.filter((item) => item.url.includes('/deployments')).length, 0)
  const staged = requests.find((item) => item.method === 'PATCH')
  assert.equal(JSON.parse(staged.body).env.GITHUB_APP_KEY_NEW.text, normalized.pkcs8)
  assert.equal(staged.url.includes('/workers/workers/worker/versions/latest'), true)
})
test('reconciles version tags in the actual top-level Cloudflare annotations shape', async () => {
  const { createGitHubAppDeploymentProvider } = await import('../../scripts/providers/github/app-deployment.ts')
  const version = {
    id: 'staged',
    annotations: { 'workers/tag': 'candidate-tag' },
    resources: { script: { etag: 'code-a' }, script_runtime: { compatibility_date: '2026-06-01' }, bindings: [] },
  }
  const provider = createGitHubAppDeploymentProvider(
    { accountId: 'a'.repeat(32), workerName: 'worker' },
    { CLOUDFLARE_API_TOKEN: 'synthetic' },
    async (url) => Response.json({ success: true, result: String(url).includes('?') ? { items: [version] } : version }),
  )
  assert.equal((await provider.taggedVersions('candidate-tag'))[0]?.tag, 'candidate-tag')
})
test('refuses a successful HTTP proof without its matching provider registry attestation', async () =>
  fixture(async (f) => {
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    await stageGitHubAppWorkerKey(plan.candidateId, f.deps)
    await deployGitHubAppWorkerVersion(plan.candidateId, f.deps)
    f.deps.fetch = async () =>
      Response.json({
        attestationId: crypto.randomUUID(),
        versionId: 'version-staged',
        fingerprint: normalized.fingerprint,
      })
    await assert.rejects(verifyGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'conflict' })
  }))
test('does not restage an unresolved intent or deploy after an unproved upload', async () =>
  fixture(async (f) => {
    f.deps.provider.stage = async () => {
      f.state.stages++
      throw new Error('lost')
    }
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    assert.equal((await stageGitHubAppWorkerKey(plan.candidateId, f.deps)).phase, 'stage_indeterminate')
    assert.equal((await stageGitHubAppWorkerKey(plan.candidateId, f.deps)).phase, 'stage_indeterminate')
    await assert.rejects(deployGitHubAppWorkerVersion(plan.candidateId, f.deps), { code: 'conflict' })
    assert.equal(f.state.stages, 1)
    assert.equal(f.state.deploys, 0)
  }))
test('rejects a changed registry revision and a missing private file before staging', async () =>
  fixture(async (f) => {
    const plan = await prepareGitHubAppDeployment(f.input, f.deps)
    f.db
      .prepare(
        'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
      )
      .run('app', JSON.stringify(f.descriptor), 'other-operation')
    await assert.rejects(stageGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'conflict' })
    assert.equal(f.state.stages, 0)
    f.db.prepare('DELETE FROM github_auth_descriptors').run()
    await rm(f.recoveryFile)
    await assert.rejects(stageGitHubAppWorkerKey(plan.candidateId, f.deps), { code: 'validation' })
    assert.equal(f.state.stages, 0)
  }))
test('requires a monotonic key revision for a new named signing key', async () =>
  fixture(async (f) => {
    f.db
      .prepare(
        'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,3,?,?)',
      )
      .run('app', JSON.stringify({ ...f.descriptor, keyRevision: 3 }), 'old')
    await assert.rejects(
      prepareGitHubAppDeployment(
        { ...f.input, expectedRevision: 1, descriptor: { ...f.descriptor, revision: 2, keyRevision: 2 } },
        f.deps,
      ),
      { code: 'conflict' },
    )
  }))
