// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json'
import {
  parseLocalVersionTag,
  parsePackageVersion,
  parseRetagOptions,
  publishedGitHubReleaseTags,
  retagCurrentVersion,
  retagUsage,
  type RetagDependencies,
} from '../../scripts/retag'

const HEAD = '1111111111111111111111111111111111111111'
const OLD_HEAD = '2222222222222222222222222222222222222222'
const TAG_OBJECT = '3333333333333333333333333333333333333333'
const TAG = 'v1.0.0'
const ANNOTATION = 'hookrelay v1.0.0\n\nStable release\n'
const ANNOTATED_TAG = `tag\0commit\0${OLD_HEAD}\0${TAG_OBJECT}\0${ANNOTATION}\n`

function packageText(version = '1.0.0'): string {
  return JSON.stringify({ name: 'hookrelay', version })
}

function releases(...values: Array<{ tag_name: string; draft: boolean }>): string {
  return JSON.stringify([values])
}

function dependencies(outputs: string[]) {
  const run = vi.fn(async (_command: string, _args: string[]): Promise<string> => {
    const output = outputs.shift()
    if (output === undefined) throw new Error('unexpected command')
    return output
  })
  const log = vi.fn((_line: string): void => undefined)
  return {
    readPackageText: async () => packageText(),
    run,
    log,
  }
}

describe('version retagging', () => {
  it('wires the standard version hooks to an atomic push and guarded helper', () => {
    expect(packageJson.scripts.postversion).toBe('git push --atomic origin main v$npm_package_version')
    expect(packageJson.scripts.retag).toBe('tsx scripts/retag.ts')
  })

  it('documents and parses the published-release override', () => {
    expect(retagUsage()).toContain('pnpm retag [--allow-published]')
    expect(parseRetagOptions([])).toEqual({ allowPublished: false, help: false })
    expect(parseRetagOptions(['--allow-published'])).toEqual({ allowPublished: true, help: false })
    expect(parseRetagOptions(['--help'])).toEqual({ allowPublished: false, help: true })
    expect(() => parseRetagOptions(['--force'])).toThrow(/unknown option/)
  })

  it('reads strict semantic versions from package.json', () => {
    expect(parsePackageVersion(packageText())).toBe('1.0.0')
    expect(parsePackageVersion(packageText('2.1.0-rc.3'))).toBe('2.1.0-rc.3')
    expect(() => parsePackageVersion('{')).toThrow(/valid JSON/)
    expect(() => parsePackageVersion(packageText('01.0.0'))).toThrow(/semantic version/)
  })

  it('distinguishes annotated, lightweight, and absent tags', () => {
    expect(parseLocalVersionTag(ANNOTATED_TAG)).toEqual({
      annotation: ANNOTATION,
      target: OLD_HEAD,
    })
    expect(parseLocalVersionTag(`commit\0\0\0${OLD_HEAD}\0commit message\n`)).toEqual({
      annotation: null,
      target: OLD_HEAD,
    })
    expect(parseLocalVersionTag('')).toBeNull()
    expect(() => parseLocalVersionTag(`tree\0\0\0${OLD_HEAD}\0`)).toThrow(/does not resolve/)
  })

  it('collects only non-draft GitHub Release tags', () => {
    expect(publishedGitHubReleaseTags(releases(
      { tag_name: 'v1.0.0', draft: false },
      { tag_name: 'v1.1.0', draft: true },
    ))).toEqual(new Set(['v1.0.0']))
    expect(() => publishedGitHubReleaseTags('{}')).toThrow(/invalid release data/)
    expect(() => publishedGitHubReleaseTags('[[{"tag_name":1,"draft":false}]]')).toThrow(/invalid release data/)
  })

  it('preserves an annotated message and force-pushes the repaired tag', async () => {
    const deps = dependencies([
      'main\n',
      '',
      `${HEAD}\n`,
      ANNOTATED_TAG,
      releases({ tag_name: TAG, draft: true }),
      '',
      '',
    ])

    await expect(retagCurrentVersion({ allowPublished: false }, deps)).resolves.toBe(TAG)
    expect(deps.run).toHaveBeenNthCalledWith(6, 'git', [
      'tag',
      '--force',
      '--annotate',
      TAG,
      '--message',
      ANNOTATION,
      HEAD,
    ])
    expect(deps.run).toHaveBeenNthCalledWith(7, 'git', [
      'push',
      '--force',
      'origin',
      `refs/tags/${TAG}:refs/tags/${TAG}`,
    ])
    expect(deps.log).toHaveBeenCalledWith(`Retagged ${TAG} at ${HEAD} and pushed it to origin`)
  })

  it('creates an annotated tag when the old tag was lightweight or absent', async () => {
    for (const tagMetadata of [`commit\0\0\0${OLD_HEAD}\0commit message\n`, '']) {
      const deps = dependencies(['main\n', '', `${HEAD}\n`, tagMetadata, '[]', '', ''])
      await retagCurrentVersion({ allowPublished: false }, deps)
      expect(deps.run).toHaveBeenNthCalledWith(6, 'git', expect.arrayContaining([
        '--annotate',
        '--message',
        `hookrelay ${TAG}`,
      ]))
    }
  })

  it('refuses branch and working-tree drift before inspecting releases or changing tags', async () => {
    const wrongBranch = dependencies(['feature\n'])
    await expect(retagCurrentVersion({ allowPublished: false }, wrongBranch)).rejects.toThrow(/must run on main/)
    expect(wrongBranch.run).toHaveBeenCalledOnce()

    const dirtyTree = dependencies(['main\n', ' M package.json\n'])
    await expect(retagCurrentVersion({ allowPublished: false }, dirtyTree)).rejects.toThrow(/clean working tree/)
    expect(dirtyTree.run).toHaveBeenCalledTimes(2)
  })

  it('requires an explicit override before moving a published release tag', async () => {
    const blocked = dependencies([
      'main\n',
      '',
      `${HEAD}\n`,
      ANNOTATED_TAG,
      releases({ tag_name: TAG, draft: false }),
    ])
    await expect(retagCurrentVersion({ allowPublished: false }, blocked)).rejects.toThrow(/--allow-published/)
    expect(blocked.run).toHaveBeenCalledTimes(5)

    const allowed = dependencies([
      'main\n',
      '',
      `${HEAD}\n`,
      ANNOTATED_TAG,
      releases({ tag_name: TAG, draft: false }),
      '',
      '',
    ])
    await expect(retagCurrentVersion({ allowPublished: true }, allowed)).resolves.toBe(TAG)
    expect(allowed.run).toHaveBeenCalledTimes(7)
  })

  it('stops before mutation when GitHub release discovery fails', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('main\n')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(`${HEAD}\n`)
      .mockResolvedValueOnce(ANNOTATED_TAG)
      .mockRejectedValueOnce(new Error('gh failed'))
    const deps: RetagDependencies = {
      readPackageText: async () => packageText(),
      run,
      log: vi.fn(),
    }
    await expect(retagCurrentVersion({ allowPublished: false }, deps)).rejects.toThrow(/gh failed/)
    expect(run).toHaveBeenCalledTimes(5)
  })
})
