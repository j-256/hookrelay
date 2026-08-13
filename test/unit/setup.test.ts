// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  WRANGLER_BULK_SECRET_LIMIT,
  addDevVar,
  deleteWranglerSecretsBulk,
  envSegment,
  getDevVar,
  privateFileIssue,
  putWranglerSecretsBulk,
  readPrivateOptionalText,
  removeDevVar,
  setDevVar,
  writePrivateText,
  writeText,
  type AtomicFileSystem,
} from '../../scripts/setup'

function modeAwareFileSystem(): AtomicFileSystem {
  const modes = new Map<string, number>()
  return {
    open,
    chmod: async (path, mode) => {
      modes.set(path, mode)
      await chmod(path, mode)
    },
    lstat: async (path) => {
      const info = await lstat(path)
      const mode = modes.get(path)
      return mode === undefined ? info : {
        mode: (info.mode & ~0o777) | mode,
        isFile: () => info.isFile(),
        isSymbolicLink: () => info.isSymbolicLink(),
      }
    },
    rename: async (source, target) => {
      await rename(source, target)
      const mode = modes.get(source)
      if (mode !== undefined) {
        modes.delete(source)
        modes.set(target, mode)
      }
    },
    unlink: async (path) => {
      modes.delete(path)
      await unlink(path)
    },
  }
}

describe('envSegment', () => {
  it('normalizes config names into secret-name segments', () => {
    expect(envSegment('github-example-owner-example-repo')).toBe('GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO')
    expect(envSegment('Personal alerts')).toBe('PERSONAL_ALERTS')
  })

  it('rejects names without letters or numbers', () => {
    expect(() => envSegment('---')).toThrow(/letter or number/)
  })
})

describe('addDevVar', () => {
  it('appends a variable with one trailing newline', () => {
    expect(addDevVar('FIRST=value\n', 'SECOND', 'secret')).toBe('FIRST=value\nSECOND=secret\n')
  })

  it('refuses to replace an existing variable', () => {
    expect(() => addDevVar('export SECOND=old\n', 'SECOND', 'new')).toThrow(/already exists/)
  })

  it('preserves an identical value and rejects a different value', () => {
    expect(setDevVar('SECOND=secret\n', 'SECOND', 'secret')).toBe('SECOND=secret\n')
    expect(() => setDevVar('SECOND=secret\n', 'SECOND', 'different')).toThrow(/different value/)
  })
})

describe('.dev.vars lookup and removal', () => {
  it('parses generated, exported, and quoted values without exposing syntax', () => {
    const text = 'PLAIN=value\nexport EXPORTED = other\nQUOTED="value with spaces"\n'
    expect(getDevVar(text, 'PLAIN')).toBe('value')
    expect(getDevVar(text, 'EXPORTED')).toBe('other')
    expect(getDevVar(text, 'QUOTED')).toBe('value with spaces')
    expect(getDevVar(text, 'MISSING')).toBeNull()
  })

  it('removes exactly one assignment while preserving surrounding content', () => {
    const text = '# local secrets\nFIRST=one\nexport SECOND = "two words"\nTHIRD=three\n'
    expect(removeDevVar(text, 'SECOND')).toBe('# local secrets\nFIRST=one\nTHIRD=three\n')
    expect(() => removeDevVar(text, 'MISSING')).toThrow(/does not exist/)
  })
})

describe('private atomic files', () => {
  it('writes private files atomically with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hookrelay-private-'))
    try {
      const path = join(directory, 'secrets.json')
      const fileSystem = modeAwareFileSystem()
      await writePrivateText(path, 'first\n', fileSystem)
      await writePrivateText(path, 'second\n', fileSystem)
      expect(await readFile(path, 'utf8')).toBe('second\n')
      expect(await readdir(directory)).toEqual(['secrets.json'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects permissive files and symbolic links before reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hookrelay-private-'))
    try {
      const target = join(directory, 'target')
      const link = join(directory, 'link')
      await writeFile(target, 'secret', { mode: 0o600 })
      await chmod(target, 0o644)
      expect(await privateFileIssue(target)).toMatch(/mode 0600/)
      await expect(readPrivateOptionalText(target)).rejects.toThrow(/mode 0600/)
      await symlink(target, link)
      expect(await privateFileIssue(link)).toMatch(/symbolic link/)
      await expect(readPrivateOptionalText(link)).rejects.toThrow(/symbolic link/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes ordinary text atomically and cleans a failed temporary file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hookrelay-atomic-'))
    try {
      const path = join(directory, 'routes.jsonc')
      await writeText(path, 'first\n')
      await writeText(path, 'second\n')
      expect(await readFile(path, 'utf8')).toBe('second\n')

      const blocked = join(directory, 'blocked')
      await mkdir(blocked)
      await writeFile(join(blocked, 'keep'), '')
      await expect(writePrivateText(blocked, 'secret')).rejects.toThrow()
      expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('Wrangler bulk secrets', () => {
  it('sends secret values through stdin and verifies resulting names', async () => {
    const runner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => args.includes('list') ? JSON.stringify([{ name: 'HMAC_ONE' }, { name: 'HMAC_TWO' }]) : '')
    await putWranglerSecretsBulk([
      { name: 'HMAC_ONE', value: 'first-secret' },
      { name: 'HMAC_TWO', value: 'second-secret' },
    ], runner)

    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe('npx')
    expect(args).toEqual(['wrangler', 'secret', 'bulk'])
    expect(args.join(' ')).not.toContain('first-secret')
    expect(JSON.parse(options!.input!)).toEqual({ HMAC_ONE: 'first-secret', HMAC_TWO: 'second-secret' })
    expect(runner.mock.calls[1]![1]).toEqual(['wrangler', 'secret', 'list'])
  })

  it('uses null values for bulk deletion and requires names to disappear', async () => {
    const runner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => args.includes('list') ? JSON.stringify([{ name: 'KEPT' }]) : '')
    await deleteWranglerSecretsBulk(['OLD_ONE', 'OLD_TWO'], runner)
    expect(JSON.parse(runner.mock.calls[0]![2]!.input!)).toEqual({ OLD_ONE: null, OLD_TWO: null })
  })

  it('enforces the per-command limit and duplicate names', async () => {
    const tooMany = Array.from({ length: WRANGLER_BULK_SECRET_LIMIT + 1 }, (_, index) => ({
      name: `SECRET_${index}`,
      value: `value-${index}`,
    }))
    await expect(putWranglerSecretsBulk(tooMany)).rejects.toThrow(/at most/)
    await expect(putWranglerSecretsBulk([
      { name: 'SAME', value: 'one' },
      { name: 'SAME', value: 'two' },
    ])).rejects.toThrow(/more than once/)
  })
})
