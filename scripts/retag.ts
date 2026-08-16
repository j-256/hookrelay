import { readFile } from 'node:fs/promises'
import { runProcess } from './setup'

const GITHUB_RELEASES_ENDPOINT = 'repos/{owner}/{repo}/releases?per_page=100'
const LOCAL_TAG_FORMAT = '%(objecttype)%00%(*objecttype)%00%(*objectname)%00%(objectname)%00%(contents)'
const MAIN_BRANCH = 'main'
const ORIGIN_REMOTE = 'origin'
const PACKAGE_PATH = 'package.json'
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export interface RetagOptions {
  allowPublished: boolean
  help: boolean
}

export interface LocalVersionTag {
  annotation: string | null
  target: string
}

export interface RetagDependencies {
  readPackageText(): Promise<string>
  run(command: string, args: string[]): Promise<string>
  log(line: string): void
}

const DEFAULT_DEPENDENCIES: RetagDependencies = {
  readPackageText: () => readFile(PACKAGE_PATH, 'utf8'),
  run: (command, args) => runProcess(command, args, { captureStdout: true }),
  log: console.log,
}

export function retagUsage(): string {
  return [
    'usage: pnpm retag [--allow-published]',
    '',
    'Moves the package version tag to clean main HEAD, preserves an existing',
    'annotated tag message, and force-pushes the repaired tag to origin.',
    '',
    'A published GitHub Release blocks the repair unless explicitly allowed.',
    '',
    'options:',
    '  --allow-published  Allow moving a tag attached to a published GitHub Release',
    '  -h, --help         Show this help',
  ].join('\n')
}

export function parseRetagOptions(argv: readonly string[]): RetagOptions {
  let allowPublished = false
  let help = false
  for (const arg of argv) {
    if (arg === '--allow-published') allowPublished = true
    else if (arg === '-h' || arg === '--help') help = true
    else throw new Error(`unknown option: ${arg}\n\n${retagUsage()}`)
  }
  return { allowPublished, help }
}

export function parsePackageVersion(text: string): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${PACKAGE_PATH} is not valid JSON`)
  }
  if (value === null || typeof value !== 'object') throw new Error(`${PACKAGE_PATH} must contain an object`)
  const version = (value as Record<string, unknown>).version
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`${PACKAGE_PATH} contains an invalid semantic version`)
  }
  return version
}

function trimRecordTerminator(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

export function parseLocalVersionTag(text: string): LocalVersionTag | null {
  if (text === '') return null
  const fields = text.split('\0')
  if (fields.length !== 5) throw new Error('Git returned malformed version tag metadata')
  const [objectType, peeledType, peeledObject, objectName, rawContents] = fields as [string, string, string, string, string]

  if (objectType === 'tag') {
    if (peeledType !== 'commit' || !OBJECT_ID_RE.test(peeledObject)) {
      throw new Error('The version tag does not resolve to a commit')
    }
    return {
      annotation: trimRecordTerminator(rawContents),
      target: peeledObject,
    }
  }
  if (objectType === 'commit' && OBJECT_ID_RE.test(objectName)) {
    return { annotation: null, target: objectName }
  }
  throw new Error('The version tag does not resolve to a commit')
}

export function publishedGitHubReleaseTags(text: string): Set<string> {
  let pages: unknown
  try {
    pages = JSON.parse(text)
  } catch {
    throw new Error('GitHub returned malformed release data')
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error('GitHub returned invalid release data')
  }

  const published = new Set<string>()
  for (const page of pages) {
    for (const value of page) {
      if (value === null || typeof value !== 'object') throw new Error('GitHub returned invalid release data')
      const release = value as Record<string, unknown>
      if (typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean') {
        throw new Error('GitHub returned invalid release data')
      }
      if (!release.draft) published.add(release.tag_name)
    }
  }
  return published
}

function requireObjectId(value: string, description: string): string {
  const normalized = value.trim()
  if (!OBJECT_ID_RE.test(normalized)) throw new Error(`Git returned an invalid ${description}`)
  return normalized
}

export async function retagCurrentVersion(
  options: Pick<RetagOptions, 'allowPublished'>,
  dependencies: RetagDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const version = parsePackageVersion(await dependencies.readPackageText())
  const tag = `v${version}`
  const branch = (await dependencies.run('git', ['branch', '--show-current'])).trim()
  if (branch !== MAIN_BRANCH) throw new Error(`retag must run on ${MAIN_BRANCH}`)

  const status = await dependencies.run('git', ['status', '--porcelain'])
  if (status.trim() !== '') throw new Error('retag requires a clean working tree')

  const head = requireObjectId(await dependencies.run('git', ['rev-parse', 'HEAD']), 'HEAD object id')
  const localTag = parseLocalVersionTag(await dependencies.run('git', [
    'for-each-ref',
    `--format=${LOCAL_TAG_FORMAT}`,
    `refs/tags/${tag}`,
  ]))
  const publishedTags = publishedGitHubReleaseTags(await dependencies.run('gh', [
    'api',
    '--paginate',
    '--slurp',
    GITHUB_RELEASES_ENDPOINT,
  ]))
  if (publishedTags.has(tag) && !options.allowPublished) {
    throw new Error(`${tag} has a published GitHub Release; rerun with --allow-published only for an intentional repair`)
  }

  const annotation = localTag?.annotation?.trim() ? localTag.annotation : `hookrelay ${tag}`
  await dependencies.run('git', [
    'tag',
    '--force',
    '--annotate',
    tag,
    '--message',
    annotation,
    head,
  ])
  await dependencies.run('git', [
    'push',
    '--force',
    ORIGIN_REMOTE,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ])
  dependencies.log(`Retagged ${tag} at ${head} and pushed it to ${ORIGIN_REMOTE}`)
  return tag
}

async function main(): Promise<void> {
  const options = parseRetagOptions(process.argv.slice(2))
  if (options.help) {
    console.log(retagUsage())
    return
  }
  await retagCurrentVersion(options)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
