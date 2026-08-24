import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { discoverGitHubFleet, parseGitHubOrigin } from '../src/discovery'

describe('GitHub origin parsing', () => {
  it('accepts HTTPS, SCP-style SSH, and ssh URLs', () => {
    expect(parseGitHubOrigin('https://github.com/example-owner/example-repo.git')).toBe('example-owner/example-repo')
    expect(parseGitHubOrigin('git@github.com:example-owner/example-repo.git')).toBe('example-owner/example-repo')
    expect(parseGitHubOrigin('ssh://git@github.com/example-owner/example-repo.git')).toBe('example-owner/example-repo')
  })

  it('rejects non-GitHub and malformed remotes', () => {
    expect(parseGitHubOrigin('https://gitlab.com/example-owner/example-repo.git')).toBeNull()
    expect(parseGitHubOrigin('https://github.com/not-a-repository')).toBeNull()
    expect(parseGitHubOrigin('not a URL')).toBeNull()
  })
})

describe('GitHub fleet discovery', () => {
  it('includes public repositories by default and only selected private repositories on opt-in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hookrelay-discovery-'))
    const children = [
      'personal',
      'organization',
      'private',
      'other-private',
      'archived',
      'readonly',
      'nongithub',
      'misleading',
      'nested',
    ]
    try {
      for (const child of children) await mkdir(join(root, child))
      await mkdir(join(root, 'nested', 'actual-root'))
      await writeFile(join(root, 'ordinary-file'), '')
      const remotes: Record<string, string> = {
        personal: 'git@github.com:example-owner/example-repo.git',
        organization: 'https://github.com/example-org/example-site.git',
        private: 'https://github.com/example-owner/private.git',
        'other-private': 'https://github.com/example-owner/other-private.git',
        archived: 'https://github.com/example-owner/archived.git',
        readonly: 'https://github.com/example-owner/readonly.git',
        nongithub: 'https://gitlab.com/example-owner/elsewhere.git',
        misleading: 'https://example.net/github.com/example-owner/misleading.git',
        nested: 'https://github.com/example-owner/nested.git',
      }
      const metadata: Record<string, Record<string, unknown>> = {
        'example-owner/example-repo': { visibility: 'PUBLIC', isArchived: false, isFork: false, viewerPermission: 'ADMIN' },
        'example-org/example-site': { visibility: 'PUBLIC', isArchived: false, isFork: false, viewerPermission: 'ADMIN' },
        'example-owner/private': { visibility: 'PRIVATE', isArchived: false, isFork: false, viewerPermission: 'ADMIN' },
        'example-owner/other-private': { visibility: 'PRIVATE', isArchived: false, isFork: false, viewerPermission: 'ADMIN' },
        'example-owner/archived': { visibility: 'PUBLIC', isArchived: true, isFork: false, viewerPermission: 'ADMIN' },
        'example-owner/readonly': { visibility: 'PUBLIC', isArchived: false, isFork: false, viewerPermission: 'WRITE' },
      }
      const runner = async (command: string, args: string[]) => {
        if (command === 'git') {
          const childPath = args[1]!
          const child = childPath.split('/').at(-1)!
          if (args[3] === '--show-toplevel') {
            return child === 'nested' ? `${join(childPath, 'actual-root')}\n` : `${childPath}\n`
          }
          return `${remotes[child]}\n`
        }
        const repo = args[2]!
        const value = metadata[repo]
        if (!value) throw new Error('metadata unavailable')
        return JSON.stringify({ nameWithOwner: repo, ...value })
      }

      const progress: string[] = []
      const result = await discoverGitHubFleet([root], { progress: (message) => progress.push(message) }, runner)
      expect(progress[0]).toBe('Inspecting repository checkout 1/10')
      expect(progress.at(-1)).toBe('Inspecting repository checkout 10/10')
      expect(progress.join('\n')).not.toContain('private')
      expect(result.repositories.map((repo) => repo.nameWithOwner)).toEqual([
        'example-org/example-site',
        'example-owner/example-repo',
      ])
      expect(result.exclusions).toEqual(expect.arrayContaining([
        expect.objectContaining({ child: 'private', reason: expect.stringMatching(/private/) }),
        expect.objectContaining({ child: 'other-private', reason: expect.stringMatching(/private/) }),
        expect.objectContaining({ child: 'nongithub', reason: expect.stringMatching(/not GitHub/) }),
        expect.objectContaining({ child: 'misleading', reason: expect.stringMatching(/not GitHub/) }),
        expect.objectContaining({ child: 'nested', reason: expect.stringMatching(/direct-child/) }),
      ]))
      expect(result.blockers.join('\n')).toMatch(/archived/)
      expect(result.blockers.join('\n')).toMatch(/admin permission/)

      const optedIn = await discoverGitHubFleet([root], {
        privateRepositories: new Set(['example-owner/private']),
      }, runner)
      expect(optedIn.repositories.map((repo) => repo.nameWithOwner)).toEqual([
        'example-org/example-site',
        'example-owner/example-repo',
        'example-owner/private',
      ])
      expect(optedIn.exclusions).toEqual(expect.arrayContaining([
        expect.objectContaining({ child: 'other-private', reason: expect.stringMatching(/private/) }),
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks malformed GitHub origins and normalized collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hookrelay-discovery-'))
    try {
      for (const child of ['first', 'second', 'malformed']) await mkdir(join(root, child))
      const remotes: Record<string, string> = {
        first: 'https://github.com/owner/a-b.git',
        second: 'https://github.com/owner/a_b.git',
        malformed: 'https://github.com/not-a-repository',
      }
      const runner = async (command: string, args: string[]) => {
        if (command === 'git') {
          const childPath = args[1]!
          const child = childPath.split('/').at(-1)!
          return args[3] === '--show-toplevel' ? childPath : remotes[child]!
        }
        const repo = args[2]!
        return JSON.stringify({
          nameWithOwner: repo,
          visibility: 'PUBLIC',
          isArchived: false,
          isFork: false,
          viewerPermission: 'ADMIN',
        })
      }
      const result = await discoverGitHubFleet([root], {}, runner)
      expect(result.blockers.join('\n')).toMatch(/malformed GitHub origin/)
      expect(result.blockers.join('\n')).toMatch(/same HMAC name/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('discovers direct-child repositories across multiple explicit roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hookrelay-discovery-'))
    const thirdPartyRoot = join(root, '3p')
    try {
      await mkdir(join(root, 'owned'))
      await mkdir(join(thirdPartyRoot, 'external'), { recursive: true })
      const remotes: Record<string, string> = {
        owned: 'https://github.com/example-owner/owned.git',
        external: 'https://github.com/example-org/external.git',
      }
      const runner = async (command: string, args: string[]) => {
        const childPath = args[1]!
        const child = childPath.split('/').at(-1)!
        if (command === 'git') {
          if (child === '3p') throw new Error('not a Git worktree')
          return args[3] === '--show-toplevel' ? childPath : remotes[child]!
        }
        const repo = args[2]!
        return JSON.stringify({
          nameWithOwner: repo,
          visibility: 'PUBLIC',
          isArchived: false,
          isFork: false,
          viewerPermission: 'ADMIN',
        })
      }

      const progress: string[] = []
      const result = await discoverGitHubFleet(
        [root, thirdPartyRoot],
        { progress: (message) => progress.push(message) },
        runner,
      )
      expect(progress).toEqual([
        'Inspecting repository checkout 1/3',
        'Inspecting repository checkout 2/3',
        'Inspecting repository checkout 3/3',
      ])
      expect(result.repositories).toEqual([
        { nameWithOwner: 'example-org/external', path: join(thirdPartyRoot, 'external'), isFork: false },
        { nameWithOwner: 'example-owner/owned', path: join(root, 'owned'), isFork: false },
      ])
      expect(result.exclusions).toContainEqual({
        child: thirdPartyRoot,
        reason: 'not a Git worktree',
      })
      expect(result.blockers).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks one GitHub identity discovered from multiple roots', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'hookrelay-discovery-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'hookrelay-discovery-second-'))
    try {
      await mkdir(join(firstRoot, 'first'))
      await mkdir(join(secondRoot, 'second'))
      const runner = async (command: string, args: string[]) => {
        const childPath = args[1]!
        if (command === 'git') {
          return args[3] === '--show-toplevel'
            ? childPath
            : 'https://github.com/example-owner/duplicate.git'
        }
        return JSON.stringify({
          nameWithOwner: 'example-owner/duplicate',
          visibility: 'PUBLIC',
          isArchived: false,
          isFork: false,
          viewerPermission: 'ADMIN',
        })
      }

      const result = await discoverGitHubFleet([firstRoot, secondRoot], {}, runner)
      expect(result.repositories.map((repository) => repository.nameWithOwner)).toEqual([
        'example-owner/duplicate',
      ])
      expect(result.blockers.join('\n')).toMatch(/discovered from both/)
    } finally {
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  })
})
