import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const helper = new URL('../../scripts/version-preflight.mjs', import.meta.url)
const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts
const npm = execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim()
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hookrelay-version-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'checkout'), bin = join(root, 'bin'), trace = join(root, 'trace')
  mkdirSync(cwd); mkdirSync(bin)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--quiet', '-b', 'version-next')
  git('config', 'user.name', 'Synthetic maintainer'); git('config', 'user.email', 'synthetic@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', join(root, 'no-hooks'))
  const hooks = { preversion: scripts.preversion, ...(scripts.postversion ? { postversion: scripts.postversion } : {}) }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'synthetic-version', version: '1.0.0', scripts: hooks }))
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'synthetic-version', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'synthetic-version', version: '1.0.0' } } }))
  if (existsSync(helper)) { mkdirSync(join(cwd, 'scripts')); writeFileSync(join(cwd, 'scripts/version-preflight.mjs'), readFileSync(helper)); git('add', 'scripts/version-preflight.mjs') }
  git('add', 'package.json', 'package-lock.json'); git('commit', '--quiet', '-m', 'Synthetic version source')
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >>"$VERSION_TEST_TRACE"\n', { mode: 0o755 })
  writeFileSync(join(root, 'empty-npmrc'), '')
  const original = git('rev-parse', 'HEAD')
  const run = flags => spawnSync(npm, ['version', 'patch', ...flags], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, npm_config_git_tag_version: undefined, NPM_CONFIG_GIT_TAG_VERSION: undefined, NPM_CONFIG_USERCONFIG: join(root, 'empty-npmrc'), PATH: `${bin}:${process.env.PATH}`, VERSION_TEST_TRACE: trace },
  })
  const version = () => JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version
  return { cwd, git, original, run, version, trace }
}
for (const flags of [['--no-git-tag-version'], ['--git-tag-version=false']]) {
  test(`actual npm version ${flags[0]} prepares PR metadata without committing, tagging or pushing`, t => {
    const f = fixture(t)
    const result = f.run(flags)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.version(), '1.0.1')
    assert.equal(f.git('rev-parse', 'HEAD'), f.original)
    assert.equal(f.git('tag', '--list'), '')
    assert.equal(f.git('remote'), '')
    assert.equal(readFileSync(f.trace, 'utf8'), 'run typecheck\ntest\n')
    assert.equal(scripts.postversion, undefined)
  })
}
for (const scenario of ['main', 'detached', 'dirty', 'implicit tag', 'explicit tag']) {
  test(`actual npm version refuses ${scenario} before changing version metadata or refs`, t => {
    const f = fixture(t)
    if (scenario === 'main') f.git('checkout', '--quiet', '-b', 'main')
    if (scenario === 'detached') f.git('checkout', '--quiet', '--detach', f.original)
    if (scenario === 'dirty') writeFileSync(join(f.cwd, 'untracked.txt'), 'unrelated operator work')
    const flags = scenario === 'implicit tag' ? [] : scenario === 'explicit tag' ? ['--git-tag-version=true'] : ['--no-git-tag-version']
    const result = f.run(flags)
    assert.notEqual(result.status, 0)
    assert.equal(f.version(), '1.0.0')
    assert.equal(f.git('rev-parse', 'HEAD'), f.original)
    assert.equal(f.git('tag', '--list'), '')
    assert.equal(existsSync(f.trace), false)
  })
}
test('version guard provides offline help and distinguishes invalid arguments, missing configuration and Git', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [helper.pathname, ...args], { encoding: 'utf8', env })
  for (const flag of ['--help', '-h']) { const r = run([flag]); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Usage:/) }
  for (const args of [['--unknown'], ['extra']]) assert.equal(run(args).status, 2)
  assert.equal(run([]).status, 2)
  assert.equal(run([], { PATH: '', npm_config_git_tag_version: '' }).status, 3)
})
