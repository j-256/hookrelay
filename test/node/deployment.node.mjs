import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { selectDeployment, verifyDeployment, prepareDeployment } from '../../scripts/deployment.ts'
import { parseReleaseCheckArguments } from '../../scripts/release-check.ts'

const VERSION_ID = '00000000-0000-4000-8000-000000000001'
const DEPLOYMENT_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_VERSION = '00000000-0000-4000-8000-000000000003'
const CONFIG = '{ "name": "hookrelay" }'
const OUTPUT = JSON.stringify({ type: 'deploy', version: 1, worker_name: 'hookrelay', version_id: VERSION_ID, targets: ['https://example.invalid'] })
const active = (overrides = {}) => ({ id: DEPLOYMENT_ID, created_on: '2026-01-02T00:00:00Z', versions: [{ version_id: VERSION_ID, percentage: 100 }], ...overrides })

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'hookrelay-deployment-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Deployment Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.3"}')
  git('add', '--', 'package.json')
  git('commit', '-qm', 'initial')
  const sha = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', sha)
  git('tag', '-a', 'v1.2.3', '-m', 'release')
  const input = { mode: 'main-commit', revision: sha, workflowRef: 'refs/heads/main', eventName: 'workflow_dispatch' }
  return { cwd, git, sha, input }
}

test('resolves a full main commit once even if main and tags advance afterward', async (t) => {
  const { cwd, git, sha, input } = repository(t)
  const selection = await selectDeployment(input, { cwd })
  assert.deepEqual(selection, { mode: 'main-commit', selection: sha, sha, packageVersion: '1.2.3' })
  git('commit', '--allow-empty', '-qm', 'advance')
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'))
  git('tag', '-f', 'v1.2.3')
  assert.equal(selection.sha, sha)
})

test('rejects non-main dispatch, malformed selectors, and commits outside main', async (t) => {
  const { cwd, git, input } = repository(t)
  for (const changes of [{ workflowRef: 'refs/heads/feature' }, { eventName: 'push' }, { mode: 'other' }, ...['', 'main', '1234567', '-bad', git('rev-parse', 'refs/tags/v1.2.3'), 'a'.repeat(40) + '\n'].map(revision => ({ revision }))]) {
    await assert.rejects(selectDeployment({ ...input, ...changes }, { cwd }))
  }
  git('checkout', '-qb', 'feature')
  git('commit', '--allow-empty', '-qm', 'feature')
  await assert.rejects(selectDeployment({ ...input, revision: git('rev-parse', 'HEAD') }, { cwd }), /main/)
})

test('uses published release tags, permits explicit prereleases, and rejects drafts and missing metadata', async (t) => {
  const { cwd, git, sha, input } = repository(t)
  let requested
  const readRelease = async tag => { requested = tag; return { tag_name: 'v1.2.3', draft: false, prerelease: false } }
  const result = await selectDeployment({ ...input, mode: 'release', revision: '' }, { cwd, readRelease })
  assert.equal(requested, undefined)
  assert.equal(result.sha, sha)
  assert.equal(result.selection, 'v1.2.3')
  for (const release of [null, { tag_name: 'v1.2.3', draft: true, prerelease: false }, { tag_name: 'v1.2.3', draft: false }, { tag_name: 'v9.9.9', draft: false, prerelease: false }]) {
    await assert.rejects(selectDeployment({ ...input, mode: 'release', revision: 'v1.2.3' }, { cwd, readRelease: async () => release }))
  }
  await assert.rejects(selectDeployment({ ...input, mode: 'release', revision: '' }, { cwd, readRelease: async () => ({ tag_name: 'v1.2.3', draft: false, prerelease: true }) }))
  writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.4-beta.1"}')
  git('add', '--', 'package.json')
  git('commit', '-qm', 'prerelease')
  git('tag', 'v1.2.4-beta.1')
  const prerelease = await selectDeployment({ ...input, mode: 'release', revision: 'v1.2.4-beta.1' }, { cwd, readRelease: async () => ({ tag_name: 'v1.2.4-beta.1', draft: false, prerelease: true }) })
  assert.equal(prerelease.packageVersion, '1.2.4-beta.1')
  git('tag', 'v8.0.0')
  await assert.rejects(selectDeployment({ ...input, mode: 'release', revision: 'v8.0.0' }, { cwd, readRelease: async () => ({ tag_name: 'v8.0.0', draft: false, prerelease: false }) }), /version/)
})

test('matches the deployed worker and version with the latest provider deployment', () => {
  const old = active({ id: OTHER_VERSION, created_on: '2026-01-01T00:00:00Z', versions: [{ version_id: OTHER_VERSION, percentage: 100 }] })
  for (const history of [[old, active()], [active(), old]]) {
    assert.deepEqual(verifyDeployment(CONFIG, OUTPUT, JSON.stringify(history)), { workerName: 'hookrelay', versionId: VERSION_ID, deploymentId: DEPLOYMENT_ID })
  }
})

test('refuses incomplete, ambiguous, wrong-worker, wrong-version and split-traffic receipts', () => {
  for (const output of ['', '{}', OUTPUT + '\n' + OUTPUT, OUTPUT.replace('hookrelay', 'other'), OUTPUT.replace(VERSION_ID, 'invalid'), OUTPUT.replace('"version":1', '"version":2')]) {
    assert.throws(() => verifyDeployment(CONFIG, output, JSON.stringify([active()])))
  }
  for (const history of [[], {}, [active({ versions: [{ version_id: OTHER_VERSION, percentage: 100 }] })], [active({ versions: [{ version_id: VERSION_ID, percentage: 50 }, { version_id: OTHER_VERSION, percentage: 50 }] })], [active({ created_on: 'invalid' })], [active(), active({ id: OTHER_VERSION })]]) {
    assert.throws(() => verifyDeployment(CONFIG, OUTPUT, JSON.stringify(history)))
  }
})

test('version preparation checks run only after the clean PR branch guard', (t) => {
  const { cwd, git } = repository(t)
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const bin = mkdtempSync(join(tmpdir(), 'hookrelay-version-bin-'))
  t.after(() => rmSync(bin, { recursive: true, force: true }))
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 })
  const guard = new URL('../../scripts/version-preflight.mjs', import.meta.url)
  if (existsSync(guard)) {
    mkdirSync(join(cwd, 'scripts'), { recursive: true })
    writeFileSync(join(cwd, 'scripts/version-preflight.mjs'), readFileSync(guard))
    git('add', 'scripts/version-preflight.mjs'); git('commit', '-qm', 'Synthetic guard')
  }
  const env = { PATH: `${bin}:${process.env.PATH}`, npm_config_git_tag_version: '' }
  const run = () => spawnSync('/bin/sh', ['-c', scripts.preversion], { cwd, env, encoding: 'utf8' })
  assert.notEqual(run().status, 0)
  git('checkout', '-qb', 'version-next')
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'run typecheck\ntest\n')
})

// CLI parsing runs in native Node because workerd does not implement util.parseArgs
test('migration preflight accepts explicit target configuration and rejects malformed arguments', () => {
  for (const args of [['--config', '/target/wrangler.jsonc'], ['-c/target/wrangler.jsonc'], ['--config=/target/wrangler.jsonc']]) {
    assert.deepEqual(parseReleaseCheckArguments(args), { help: false, config: '/target/wrangler.jsonc' })
  }
  for (const flag of ['--help', '-h']) assert.equal(parseReleaseCheckArguments([flag]).help, true)
  for (const args of [['--config='], ['--unknown'], ['--config'], ['extra']]) assert.throws(() => parseReleaseCheckArguments(args))
})

test('operator CLIs provide offline help, reject invalid arguments, and retain only safe receipt identifiers', (t) => {
  const { cwd, input, sha } = repository(t)
  const script = new URL('../../scripts/deployment.ts', import.meta.url).pathname
  const preflight = new URL('../../scripts/release-check.ts', import.meta.url).pathname
  const run = (file, args, env = {}) => spawnSync(process.execPath, ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname, file, ...args], { cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env }, encoding: 'utf8' })
  for (const file of [script, preflight]) {
    for (const flag of ['-h', '--help']) {
      const result = run(file, [flag])
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /Usage:/)
      assert.equal(result.stderr, '')
    }
    assert.equal(run(file, ['--unexpected']).status, 2)
  }
  const output = join(cwd, 'output')
  const selection = run(script, ['select', '--mode=main-commit', '--revision', sha], { GITHUB_EVENT_NAME: input.eventName, GITHUB_REF: input.workflowRef, GITHUB_OUTPUT: output })
  assert.equal(run(script, ['select', '--mode', 'invalid'], { GITHUB_EVENT_NAME: input.eventName, GITHUB_REF: input.workflowRef }).status, 2)
  assert.equal(selection.status, 0, selection.stderr)
  const target = join(cwd, 'prepared-source')
  const prepared = run(script, ['prepare', '--mode', 'main-commit', '--revision', sha, '--sha', sha, '--directory', target], { GITHUB_EVENT_NAME: input.eventName, GITHUB_REF: input.workflowRef })
  assert.equal(prepared.status, 0, prepared.stderr)
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim(), sha)
  assert.match(readFileSync(output, 'utf8'), new RegExp(`sha=${sha}\\n`))
  for (const [name, value] of [['wrangler.jsonc', CONFIG], ['deploy.ndjson', OUTPUT], ['history.json', JSON.stringify([active()])]]) writeFileSync(join(cwd, name), value)
  const summary = join(cwd, 'summary')
  const result = run(script, ['verify', '--config', join(cwd, 'wrangler.jsonc'), '--output', join(cwd, 'deploy.ndjson'), '--deployments', join(cwd, 'history.json')], { GITHUB_STEP_SUMMARY: summary })
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(summary, 'utf8'), /Provider verification: matched/)
  assert.doesNotMatch(result.stdout + readFileSync(summary, 'utf8'), /https:/)
})

test('prepares only the validated immutable commit from a detached trusted checkout', async (t) => {
  const { cwd, git, sha, input } = repository(t)
  git('checkout', '--detach', sha)
  const target = join(cwd, 'target')
  const result = await prepareDeployment({ ...input, sha, directory: target }, { cwd })
  assert.equal(result.sha, sha)
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: target, encoding: 'utf8' }).trim(), sha)
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version, '1.2.3')
})

test('preparation refuses untrusted or changed revisions before creating a destination', async (t) => {
  const { cwd, git, sha, input } = repository(t)
  const target = join(cwd, 'target')
  git('checkout', '-qb', 'feature')
  git('commit', '--allow-empty', '-qm', 'feature')
  const feature = git('rev-parse', 'HEAD')
  await assert.rejects(prepareDeployment({ ...input, revision: feature, sha: feature, directory: target }, { cwd }))
  assert.equal(existsSync(target), false)
  git('tag', '-f', 'v1.2.3', feature)
  await assert.rejects(prepareDeployment({ ...input, mode: 'release', revision: 'v1.2.3', sha, directory: target }, { cwd, readRelease: async () => ({ tag_name: 'v1.2.3', draft: false, prerelease: false }) }), /changed/)
  assert.equal(existsSync(target), false)
  mkdirSync(target)
  writeFileSync(join(target, 'keep'), 'preserve')
  await assert.rejects(prepareDeployment({ ...input, sha, directory: target }, { cwd }))
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'preserve')
})
