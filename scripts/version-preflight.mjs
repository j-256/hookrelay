import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_BYTES = 64 * 1024
const HELP = `Usage: npm version --no-git-tag-version <major|minor|patch>

Prepare version metadata on a clean named topic branch for a version PR
This internal preversion guard requires Node, Git and the explicit npm no-tag flag
The package hook then runs typechecking and tests before npm updates the files
Commit and integrate the version PR before explicitly publishing its release tag
-h, --help  Show help without Git or provider access
Exit status: 0 safe preparation, 1 Git failure, 2 usage/precondition error,
3 missing Git dependency
`

async function main() {
  let args
  try {
    args = parseArgs({ allowPositionals: false, options: { help: { type: 'boolean', short: 'h' } } })
  } catch { console.error(HELP); return 2 }
  if (args.values.help) { console.log(HELP); return 0 }
  if (!Object.hasOwn(process.env, 'npm_config_git_tag_version') ||
      !['', 'false'].includes(process.env.npm_config_git_tag_version)) {
    console.error('version-preflight: use npm version --no-git-tag-version on a clean version PR branch')
    return 2
  }
  let branch, status
  try {
    const git = args => execFileSync('git', args, {
      encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_BYTES,
    }).trim()
    branch = git(['branch', '--show-current'])
    status = git(['status', '--porcelain'])
  } catch (error) {
    console.error(error.code === 'ENOENT'
      ? 'version-preflight: Git is required'
      : 'version-preflight: Git state could not be inspected')
    return error.code === 'ENOENT' ? 3 : 1
  }
  if (!branch || branch === 'main' || status) {
    console.error('version-preflight: prepare the version on a clean named topic branch, then integrate its PR')
    return 2
  }
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
