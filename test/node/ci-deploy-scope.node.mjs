import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { test } from 'node:test'
import { deployRequiredForPaths } from '../../scripts/ci-deploy-scope.mjs'

const SCRIPT = resolve('scripts/ci-deploy-scope.mjs')

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('only a nonempty set of known non-runtime paths skips deployment', () => {
  assert.equal(deployRequiredForPaths(['.github/workflows/ci.yml', 'scripts/sync.ts', 'integrations/github-fleet/src/cli.ts', 'test/node/a.node.mjs', 'docs/screenshots/cover.png', 'tools/cover/capture.mjs', 'README.md', 'AGENTS.md']), false)
  for (const paths of [[], ['src/index.ts'], ['wrangler.jsonc'], ['package.json'], ['pnpm-lock.yaml'], ['migrations/0002.sql'], ['new-root-file'], ['docs/readme.md', 'src/index.ts']]) {
    assert.equal(deployRequiredForPaths(paths), true, paths.join(', '))
  }
})

test('push range includes every commit and handles unusual path names', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'hookrelay-ci-scope-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'CI Test')
  git(repo, 'config', 'user.email', 'ci@example.invalid')
  mkdirSync(join(repo, 'docs'))
  writeFileSync(join(repo, 'docs', 'first.md'), 'first')
  git(repo, 'add', '--', 'docs/first.md')
  git(repo, 'commit', '-qm', 'first')
  const before = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'docs', 'line\nbreak.md'), 'second')
  git(repo, 'add', '--', 'docs/line\nbreak.md')
  git(repo, 'commit', '-qm', 'second')
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts', 'operator.mjs'), 'third')
  git(repo, 'add', '--', 'scripts/operator.mjs')
  git(repo, 'commit', '-qm', 'third')
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'workflow')
  git(repo, 'add', '--', '.github/workflows/ci.yml')
  git(repo, 'commit', '-qm', 'workflow')
  const toolingHead = git(repo, 'rev-parse', 'HEAD')
  const output = join(repo, 'github-output')
  const run = (base, head) => {
    writeFileSync(output, '')
    execFileSync(process.execPath, [SCRIPT], {
      cwd: repo,
      env: { ...process.env, GITHUB_EVENT_BEFORE: base, GITHUB_SHA: head, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    })
    return readFileSync(output, 'utf8')
  }
  assert.equal(run(before, toolingHead), 'deploy_required=false\n')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'index.ts'), 'runtime')
  git(repo, 'add', '--', 'src/index.ts')
  git(repo, 'commit', '-qm', 'runtime')
  const runtimeHead = git(repo, 'rev-parse', 'HEAD')
  assert.equal(run(before, runtimeHead), 'deploy_required=true\n')
  assert.equal(run('0'.repeat(40), toolingHead), 'deploy_required=true\n')
  assert.equal(run('f'.repeat(40), toolingHead), 'deploy_required=true\n')
})
