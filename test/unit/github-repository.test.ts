import { describe, expect, it, vi } from 'vitest'
import {
  listGitHubRepositoryHooks,
  matchingGitHubRepositoryHooks,
  parseGitHubRepositoryHookPages,
  requireMatchingGitHubRepositoryHook,
  sameGitHubEvents,
  updateGitHubRepositoryHookEvents,
  type GitHubRepositoryHook,
} from '../../scripts/github-repository'
import { hashSubscriptionSlug } from '../../src/lib/subscription'

const FIRST_SLUG = 'abcdefghijklmnopqrstuv'
const SECOND_SLUG = 'zyxwvutsrqponmlkjihgfe'

function hook(id: number, url: string, events: string[] = ['push']): GitHubRepositoryHook {
  return {
    id,
    active: true,
    events,
    config: { url, content_type: 'json', insecure_ssl: '0' },
  }
}

describe('GitHub repository hook reads', () => {
  it('parses paginated gh output and requests every page without printing it', async () => {
    const pages = JSON.stringify([
      [hook(1, `https://hooks.example.com/hook/github/${FIRST_SLUG}`)],
      [hook(2, `https://hooks.example.com/hook/github/${SECOND_SLUG}`, ['star'])],
    ])
    const runner = vi.fn(async (
      _command: string,
      _args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => pages)

    await expect(listGitHubRepositoryHooks('example-owner/example-repo', runner)).resolves.toHaveLength(2)
    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe('gh')
    expect(args).toContain('--paginate')
    expect(args).toContain('--slurp')
    expect(args).toContain('repos/example-owner/example-repo/hooks?per_page=100')
    expect(options).toEqual({ captureStdout: true })
    await expect(listGitHubRepositoryHooks('invalid', runner)).rejects.toThrow()
  })

  it('rejects malformed or incomplete API output', () => {
    expect(() => parseGitHubRepositoryHookPages('not json')).toThrow(/malformed/)
    expect(() => parseGitHubRepositoryHookPages('{}')).toThrow(/invalid/)
    expect(() => parseGitHubRepositoryHookPages('[[{"id": 1}]]')).toThrow(/invalid/)
  })
})

describe('GitHub repository hook identity', () => {
  it('matches one of several hooks on the same repository by its private slug hash', async () => {
    const hooks = [
      hook(1, `https://hooks.example.com/hook/github/${FIRST_SLUG}`),
      hook(2, `https://hooks.example.com/hook/github/${SECOND_SLUG}`, ['star', 'watch']),
      hook(3, 'https://hooks.example.com/not-hookrelay'),
    ]
    const matched = await requireMatchingGitHubRepositoryHook(
      hooks,
      await hashSubscriptionSlug(SECOND_SLUG),
      'github:example-owner/example-repo:stars',
      'example-owner/example-repo',
    )

    expect(matched.id).toBe(2)
    await expect(matchingGitHubRepositoryHooks(hooks, await hashSubscriptionSlug(SECOND_SLUG))).resolves.toEqual([
      hooks[1],
    ])
  })

  it('reports missing and duplicate matches without exposing webhook URLs or slugs', async () => {
    const first = hook(1, `https://hooks.example.com/hook/github/${FIRST_SLUG}`)
    const slugHash = await hashSubscriptionSlug(SECOND_SLUG)

    let missing: Error | undefined
    try {
      await requireMatchingGitHubRepositoryHook([first], slugHash, 'stars', 'example-owner/example-repo')
    } catch (err) {
      missing = err as Error
    }
    expect(missing?.message).toMatch(/not found/)
    expect(missing?.message).not.toContain(FIRST_SLUG)
    expect(missing?.message).not.toContain('hooks.example.com')

    await expect(requireMatchingGitHubRepositoryHook(
      [
        hook(2, `https://hooks.example.com/hook/github/${SECOND_SLUG}`),
        hook(3, `https://other.example.com/hook/github/${SECOND_SLUG}`),
      ],
      slugHash,
      'stars',
      'example-owner/example-repo',
    )).rejects.toThrow(/multiple/)
  })
})

describe('GitHub repository hook updates', () => {
  it('compares event arrays as sets', () => {
    expect(sameGitHubEvents(['star', 'watch'], ['watch', 'star'])).toBe(true)
    expect(sameGitHubEvents(['star'], ['star', 'watch'])).toBe(false)
    expect(sameGitHubEvents(['star', 'star'], ['star', 'star'])).toBe(false)
    expect(sameGitHubEvents(['*'], ['*'])).toBe(true)
  })

  it('PATCHes events while preserving hook config and suppressing the secret-bearing response', async () => {
    const runner = vi.fn(async (
      _command: string,
      _args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => '')
    const existing = hook(123, `https://hooks.example.com/hook/github/${FIRST_SLUG}`)
    await updateGitHubRepositoryHookEvents(
      'example-owner/example-repo',
      existing,
      ['star', 'watch'],
      'local-hmac-secret',
      runner,
    )

    const [command, args, options] = runner.mock.calls[0]!
    expect(command).toBe('gh')
    expect(args).toContain('PATCH')
    expect(args).toContain('--silent')
    expect(args).toContain('repos/example-owner/example-repo/hooks/123')
    expect(args).not.toContain('local-hmac-secret')
    expect(JSON.parse(options!.input!)).toEqual({
      active: true,
      events: ['star', 'watch'],
      config: {
        url: `https://hooks.example.com/hook/github/${FIRST_SLUG}`,
        content_type: 'json',
        insecure_ssl: '0',
        secret: 'local-hmac-secret',
      },
    })
  })
})
