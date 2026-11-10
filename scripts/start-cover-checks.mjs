import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const COVER = 'docs/screenshots/cover.png'
const SHA = /^[a-f0-9]{40}$/
const WORKFLOW = /^[a-zA-Z0-9_-]+\.yml$/
const WAIT_MS = 120_000
const POLL_MS = 2_000
const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_BYTES = 4 * 1024 * 1024
const HELP = `Usage: node scripts/start-cover-checks.mjs PR_NUMBER HEAD_SHA

Start normal CI for the exact generated-cover PR and print its checked head SHA
Requires Node, gh, GH_TOKEN with scoped Actions write and repository/PR read,
GITHUB_REPOSITORY, GITHUB_SHA for the source build, and COVER_WORKFLOWS as a
comma-separated list of allowed workflow filenames
HEAD_SHA is the exact candidate commit whose tree and artifact were checked locally
Only same-repository bot PRs modifying the cover image are admitted
Progress goes to stderr; no PR review or status-check bypass is performed
-h, --help  Show help without provider access
Exit status: 0 verified workflows admitted, 1 runtime/verification failure,
2 usage or precondition error, 3 missing dependency
`

export async function startCoverChecks({
  repository, sourceSha, expectedHeadSha, number, workflows, api,
  now = Date.now, sleep = delay, log = console.error,
}) {
  assert.match(repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
  assert.match(sourceSha, SHA)
  assert.match(expectedHeadSha, SHA)
  assert.ok(Number.isSafeInteger(number) && number > 0)
  assert.ok(workflows.length > 0 && workflows.every(name => WORKFLOW.test(name)))
  const expected = new Set(workflows.map(name => `.github/workflows/${name}`))
  const prefix = `repos/${repository}`
  const headSha = expectedHeadSha
  async function verifyPr() {
    const pr = await api(`${prefix}/pulls/${number}`)
    assert.equal(pr.state, 'open')
    assert.equal(pr.draft, false)
    assert.equal(pr.base.ref, 'main')
    assert.equal(pr.base.sha, sourceSha, 'A newer source revision superseded this cover')
    assert.equal(pr.base.repo.full_name, repository)
    assert.equal(pr.head.repo.full_name, repository)
    assert.match(pr.head.sha, SHA)
    assert.equal(pr.head.sha, headSha, 'The generated-cover PR head differs from the checked candidate')
    assert.equal(pr.user.login, 'github-actions[bot]')
    assert.equal(pr.head.ref, `automation/project-cover-${sourceSha}`)
    assert.equal(pr.changed_files, 1)
    const files = await api(`${prefix}/pulls/${number}/files`)
    assert.deepEqual(files.map(file => [file.filename, file.status]), [[COVER, 'modified']])
    return pr.head.sha
  }
  await verifyPr()
  const started = new Set()
  const deadline = now() + WAIT_MS
  while (now() < deadline) {
    const result = await api(`${prefix}/actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`)
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count <= 100, 'Too many matching workflow runs to verify safely')
    for (const run of result.workflow_runs) {
      if (!expected.has(run.path) || started.has(run.path)) continue
      assert.equal(run.event, 'pull_request')
      assert.equal(run.head_sha, headSha)
      assert.equal(run.head_repository.full_name, repository)
      assert.ok(run.pull_requests.some(item => item.number === number))
      if (run.conclusion === 'action_required') {
        assert.ok(Number.isSafeInteger(run.id) && run.id > 0)
        await verifyPr()
        await api(`${prefix}/actions/runs/${run.id}/approve`, 'POST')
      }
      started.add(run.path)
      log(`Admitted ${run.path} for verified cover PR #${number}`)
    }
    if (started.size === expected.size) {
      await verifyPr()
      return { headSha }
    }
    await sleep(POLL_MS)
  }
  throw new Error(`Timed out waiting for cover PR workflows: ${[...expected].filter(path => !started.has(path)).join(', ')}`)
}

async function main() {
  let args
  try {
    args = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } })
  } catch {
    console.error(HELP)
    return 2
  }
  if (args.values.help) { console.log(HELP); return 0 }
  const [value, expectedHeadSha] = args.positionals
  const number = Number(value)
  if (args.positionals.length !== 2 || !SHA.test(expectedHeadSha ?? '') || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(number)) {
    console.error('cover-checks: expected a PR number and checked candidate SHA; see --help')
    return 2
  }
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, COVER_WORKFLOWS } = process.env
  const workflows = COVER_WORKFLOWS?.split(',') ?? []
  if (!GH_TOKEN || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GITHUB_REPOSITORY ?? '') ||
      !SHA.test(GITHUB_SHA ?? '') || !workflows.length || !workflows.every(name => WORKFLOW.test(name))) {
    console.error('cover-checks: required workflow environment is missing or invalid; see --help')
    return 2
  }
  try {
    const result = await startCoverChecks({
      repository: GITHUB_REPOSITORY, sourceSha: GITHUB_SHA, expectedHeadSha, number, workflows,
      api(path, method = 'GET') {
        const text = execFileSync('gh', ['api', '--method', method, path], {
          encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_BYTES,
        })
        return text.trim() ? JSON.parse(text) : null
      },
    })
    console.log(result.headSha)
    return 0
  } catch (error) {
    console.error(`cover-checks: ${error.message}`)
    return error.code === 'ENOENT' ? 3 : 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
