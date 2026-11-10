import { mkdir, lstat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
import { writeNewPrivateAppDocument } from './providers/github/app-private-file'
import { GitHubAuthError } from '../src/lib/github-app-contract'

const PRIVATE_DIRECTORY = '.hookrelay-private'
export async function savePrivateSubscriptionSetup(
  value: Record<string, unknown>,
  output?: string,
) {
  try {
    let path = output ? resolve(output) : undefined
    if (!path) {
      const directory = resolve(PRIVATE_DIRECTORY)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        throw new GitHubAuthError('validation')
      path = join(directory, randomUUID() + '.json')
    }
    await writeNewPrivateAppDocument(path, {
      ...value,
      version: 1,
      kind: 'hookrelay-subscription',
      createdAt: new Date().toISOString(),
    })
    return path
  } catch (error) {
    throw Object.assign(
      new Error(
        'Receiver recovery could not be saved; choose a new protected file with an owner-controlled parent',
      ),
      {
        code:
          error instanceof GitHubAuthError && error.code === 'validation'
            ? 'validation'
            : 'unavailable',
      },
    )
  }
}
