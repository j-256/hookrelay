import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NON_RUNTIME_DIRECTORIES = Object.freeze(['docs/', 'integrations/', 'scripts/', 'test/', 'tools/cover/'])
const NON_RUNTIME_FILES = new Set(['AGENTS.md', 'README.md'])
const COMMIT_ID = /^[a-f0-9]{40,64}$/
const INITIAL_COMMIT_ID = /^0+$/

export function deployRequiredForPaths(paths) {
  if (paths.length === 0) return true
  return paths.some((path) => !NON_RUNTIME_FILES.has(path) && !NON_RUNTIME_DIRECTORIES.some((directory) => path.startsWith(directory)))
}

function git(args) {
  return spawnSync('git', args, { encoding: 'buffer' })
}

function deploymentScope(before, head) {
  if (!COMMIT_ID.test(before) || !COMMIT_ID.test(head) || INITIAL_COMMIT_ID.test(before)) {
    return { required: true, reason: 'push history is unavailable' }
  }
  if (git(['merge-base', '--is-ancestor', before, head]).status !== 0) {
    return { required: true, reason: 'push base is unavailable or not an ancestor' }
  }
  const changed = git(['diff', '--name-only', '--no-renames', '-z', before, head, '--'])
  if (changed.status !== 0 || !Buffer.isBuffer(changed.stdout)) {
    return { required: true, reason: 'changed paths are unavailable' }
  }
  const paths = changed.stdout.toString('utf8').split('\0').filter(Boolean)
  if (paths.length === 0) return { required: true, reason: 'push contains no changed paths' }
  return {
    required: deployRequiredForPaths(paths),
    reason: `${paths.length} changed path${paths.length === 1 ? '' : 's'} checked`,
  }
}

function main() {
  const { required, reason } = deploymentScope(process.env.GITHUB_EVENT_BEFORE ?? '', process.env.GITHUB_SHA ?? '')
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  appendFileSync(process.env.GITHUB_OUTPUT, `deploy_required=${required}\n`)
  console.log(`Production deploy ${required ? 'required' : 'skipped'}: ${reason}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
