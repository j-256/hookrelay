import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { runGitHubAppRegistration } from '../../scripts/providers/github/app-registration.ts'
import { readGitHubAppPrivateFile } from '../../scripts/providers/github/app-private-file.ts'
import {
  prepareGitHubAppDeployment,
  stageGitHubAppWorkerKey,
  deployGitHubAppWorkerVersion,
  verifyGitHubAppWorkerKey,
  activateGitHubAppDeployment,
} from '../../scripts/providers/github/app-deployment.ts'
import { handleGitHubAppKeyVerification } from '../../src/management/github-app-key-verification.ts'
import { resolveOperatorGitHubAuth } from '../../scripts/providers/github/auth.ts'
import {
  inspectGitHubHookOperations,
  reconcileGitHubHookOperation,
} from '../../scripts/providers/github/operation-recovery.ts'
import { resolveGitHubAuth } from '../../src/lib/github-auth.ts'
import { invalidateGitHubAuthAuthority } from '../../src/configuration/github-auth.ts'
import { signGitHubAppJwt } from '../../src/lib/github-app-token.ts'

test('guided local preparation survives lost staging, deployment and hook acknowledgements without duplicating effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hookrelay-app-workflow-'))
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for (const file of [
      '0012_github_app_auth.sql',
      '0013_github_app_deployment.sql',
      '0015_github_hook_operation_intents.sql',
      '0016_github_hook_operation_reconciliation.sql',
    ])
      db.exec(await readFile(join('migrations', file), 'utf8'))
    const query = async ({ sql, params }) => db.prepare(sql).all(...params)
    const database = {
      prepare(sql) {
        return {
          bind(...params) {
            return { all: async () => ({ success: true, results: db.prepare(sql).all(...params) }) }
          },
        }
      },
    }
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString()
    const recoveryFile = join(root, 'recovery.json')
    const decode = (value) =>
      value
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
    const registered = await runGitHubAppRegistration({
      account: { login: 'example', type: 'Organization' },
      name: 'Synthetic workflow',
      visibility: 'public',
      homepage: 'https://hooks.example',
      capability: 'repository-hooks-write',
      attemptFile: join(root, 'attempt.json'),
      outputFile: recoveryFile,
      fetch: async () =>
        Response.json({
          id: 42,
          slug: 'synthetic-workflow',
          owner: { id: 50, login: 'example', type: 'Organization' },
          pem: key,
          webhook_secret: 'synthetic-unused-app-hook-secret',
        }),
      openBrowser: async (url) => {
        const html = await (await fetch(url)).text()
        const manifest = JSON.parse(decode(/value="([^"]+)"/.exec(html)[1]))
        assert.equal(manifest.hook_attributes.active, false)
        assert.deepEqual(manifest.default_events, [])
        const action = new URL(decode(/action="([^"]+)"/.exec(html)[1]))
        const callback = new URL(manifest.redirect_url)
        callback.searchParams.set('state', action.searchParams.get('state'))
        callback.searchParams.set('code', 'syntheticworkflowcode')
        assert.equal((await fetch(callback)).status, 200)
      },
    })
    assert.equal(registered.phase, 'prepared')
    assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600)
    const material = await readGitHubAppPrivateFile(recoveryFile)
    const target = { accountId: 'a'.repeat(32), workerName: 'synthetic-worker' }
    const identity = {
      target,
      databaseId: '11111111-1111-4111-8111-111111111111',
      configDigest: 'b'.repeat(64),
    }
    const descriptor = {
      id: 'workflow',
      revision: 1,
      keyRevision: 1,
      mode: 'app',
      appId: 42,
      installationId: 7,
      accountId: 50,
      keySecretName: 'GITHUB_APP_WORKFLOW',
      fingerprint: material.fingerprint,
      repositories: [{ id: 101, fullName: 'example/repository', ownerId: 50, private: true }],
      managementWorkspaces: ['alpha'],
      capabilities: ['repository-hooks-read', 'repository-hooks-write'],
      state: 'active',
    }
    const hooks = []
    const state = {
      latest: 'version-base',
      serving: 'version-old',
      stages: 0,
      deploys: 0,
      creates: 0,
      lostHook: true,
      pinged: false,
    }
    const versions = new Map([
      [
        'version-base',
        {
          id: 'version-base',
          scriptEtag: 'reviewed-code',
          runtimeDigest: 'c'.repeat(64),
          bindings: [
            { type: 'd1', name: 'EVENTS_DB', id: identity.databaseId },
            { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
            { type: 'secret_text', name: 'RETAINED_EXISTING_SECRET' },
          ],
          secrets: { RETAINED_EXISTING_SECRET: 'synthetic-retained' },
        },
      ],
    ])
    const github = async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/app/installations/7')
        return Response.json({
          id: 7,
          app_id: 42,
          account: { id: 50 },
          permissions: { repository_hooks: 'write' },
          suspended_at: null,
        })
      if (path.endsWith('/access_tokens')) {
        const body = JSON.parse(init.body)
        return Response.json({
          token: 'synthetic-workflow-installation-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: body.permissions,
          repositories: [
            { id: 101, full_name: 'example/repository', owner: { id: 50 }, private: true },
          ],
        })
      }
      if (path.endsWith('/pings')) {
        state.pinged = true
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/deliveries'))
        return Response.json(
          state.pinged
            ? [
                {
                  guid: 'fresh-workflow-ping',
                  event: 'ping',
                  status_code: 200,
                  delivered_at: new Date().toISOString(),
                },
              ]
            : [],
        )
      assert.equal(path, '/repos/example/repository/hooks')
      if (init?.method === 'POST') {
        state.creates++
        const body = JSON.parse(init.body)
        hooks.push({ ...body, id: 42 })
        if (state.lostHook) throw new Error('synthetic-lost-hook')
        return Response.json({ ...body, id: 42 }, { status: 201 })
      }
      return Response.json(hooks.map((h) => ({ ...h, config: { ...h.config, secret: undefined } })))
    }
    const metadata = ({ secrets, ...version }) => version
    const provider = {
      latestVersion: async () => metadata(versions.get(state.latest)),
      version: async (id) => metadata(versions.get(id)),
      stage: async (name, key, tag) => {
        state.stages++
        const previous = versions.get(state.latest)
        const version = {
          ...previous,
          id: 'version-staged',
          tag,
          bindings: [...previous.bindings, { name, type: 'secret_text' }],
          secrets: { ...previous.secrets, [name]: key },
        }
        versions.set(version.id, version)
        state.latest = version.id
        throw new Error('synthetic-lost-stage')
      },
      taggedVersions: async (tag) =>
        [...versions.values()].filter((version) => version.tag === tag).map(metadata),
      deployment: async () => ({ ...target, versionId: state.serving, singleVersion: true }),
      deploy: async (id) => {
        state.deploys++
        state.serving = id
        throw new Error('synthetic-lost-deploy')
      },
    }
    const deps = {
      query,
      provider,
      recoveryFile,
      currentIdentity: async () => identity,
      fetch: async (url, init) => {
        if (new URL(url).origin === 'https://api.github.com') return github(url, init)
        const loaded = versions.get(state.serving)
        return handleGitHubAppKeyVerification(new Request(url, init), {
          EVENTS_DB: database,
          CF_VERSION_METADATA: { id: loaded.id, tag: '', timestamp: '' },
          ...loaded.secrets,
        })
      },
    }
    const plan = await prepareGitHubAppDeployment(
      {
        ...identity,
        descriptor,
        expectedRevision: 0,
        baseVersionId: 'version-base',
        verificationOrigin: 'https://hooks.example',
      },
      deps,
    )
    assert.equal(
      (await stageGitHubAppWorkerKey(plan.candidateId, deps)).phase,
      'stage_indeterminate',
    )
    assert.equal((await stageGitHubAppWorkerKey(plan.candidateId, deps)).phase, 'staged')
    assert.equal(
      (await deployGitHubAppWorkerVersion(plan.candidateId, deps)).phase,
      'deployment_indeterminate',
    )
    assert.equal((await deployGitHubAppWorkerVersion(plan.candidateId, deps)).phase, 'deployed')
    await verifyGitHubAppWorkerKey(plan.candidateId, deps)
    const receipt = await activateGitHubAppDeployment(plan.candidateId, deps)
    assert.deepEqual(await activateGitHubAppDeployment(plan.candidateId, deps), receipt)
    assert.equal(state.stages, 1)
    assert.equal(state.deploys, 1)
    assert.equal(versions.get(state.serving).secrets.RETAINED_EXISTING_SECRET, 'synthetic-retained')
    const auth = await resolveOperatorGitHubAuth(
      { mode: 'app', descriptorId: 'workflow', workspaceId: 'alpha', credentialFile: recoveryFile },
      {
        query,
        fetch: github,
        runner: async () => {
          throw new Error('implicit CLI must not run')
        },
      },
    )
    const originalRequest = {
      operation: 'create',
      repo: 'example/repository',
      webhookUrl: 'https://hooks.example/hook/github/abcdefghijklmnopqrstuv',
      secret: 'synthetic-repository-hmac',
      events: ['push'],
    }
    await assert.rejects(auth.transport.request(originalRequest), { code: 'indeterminate' })
    state.lostHook = false
    await assert.rejects(auth.transport.request(originalRequest), { code: 'indeterminate' })
    assert.equal(state.creates, 1)
    db.prepare('UPDATE github_hook_operations SET updated_at=updated_at-9000').run()
    const operation = (await inspectGitHubHookOperations(query, auth, {})).operations[0]
    const recovered = await reconcileGitHubHookOperation(query, auth, {
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      requestHash: operation.requestHash,
      originalRequest,
      acknowledgeUncertainOutcome: true,
      observation: 'present',
    })
    assert.equal(recovered.historicalState, 'indeterminate')
    assert.equal(recovered.observation, 'present')
    assert.equal(state.creates, 1)
    assert.equal(state.pinged, true)
    const publicState = JSON.stringify({ plan, receipt, operation, recovered })
    for (const canary of [
      'PRIVATE KEY',
      'synthetic-repository-hmac',
      'synthetic-workflow-installation-token',
      originalRequest.webhookUrl,
    ])
      assert.equal(publicState.includes(canary), false)
    await invalidateGitHubAuthAuthority(query, 'workflow')
    const costDescriptor = { ...descriptor, id: 'synthetic-cost' }
    db.prepare(
      'INSERT INTO github_auth_descriptors(id,revision,key_revision,metadata_json,write_id) VALUES (?,1,1,?,?)',
    ).run(costDescriptor.id, JSON.stringify(costDescriptor), crypto.randomUUID())
    const costs = []
    const request = {
      query,
      selection: { mode: 'app', descriptorId: 'synthetic-cost' },
      workspaceId: 'alpha',
      callerId: 'synthetic-cost',
      repositoryFullName: 'example/repository',
      capability: 'repository-hooks-read',
      phase: 'read',
      fetch: github,
      loadPrivateKey: async () => material.privateKey,
      diagnostic: (event) => costs.push(event),
    }
    await resolveGitHubAuth(request)
    await resolveGitHubAuth(request)
    await resolveGitHubAuth({ ...request, phase: 'effect' })
    assert.deepEqual(
      costs.map((row) => row.providerRequests),
      [2, 0, 2],
    )
    assert.ok(costs[0].d1Requests <= 6, 'Cold authority work must fit its D1 request budget')
    assert.ok(costs[1].d1Requests <= 4, 'Warm authority work must fit its D1 request budget')
    const cpuStart = process.cpuUsage()
    for (let i = 0; i < 100; i++) await signGitHubAppJwt(material.privateKey, 42, Date.now())
    const cpu = process.cpuUsage(cpuStart)
    const journalSizes = db
      .prepare('SELECT * FROM github_hook_operations')
      .all()
      .map((row) => Buffer.byteLength(JSON.stringify(row)))
    console.log(
      JSON.stringify({
        msg: 'github.app.synthetic-resource-sample',
        journalRowBytes: { min: Math.min(...journalSizes), max: Math.max(...journalSizes) },
        node: process.version,
        architecture: process.arch,
        keyBytes: Buffer.byteLength(material.privateKey),
        jwtSigningCpuMsPerOperation: Math.round((cpu.user + cpu.system) / 100) / 1000,
        authority: costs.map(({ providerRequests, d1Requests, durationMs }) => ({
          providerRequests,
          d1Requests,
          durationMs,
        })),
      }),
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
