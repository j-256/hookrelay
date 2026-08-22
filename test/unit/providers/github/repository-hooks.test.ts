import { describe, expect, it, vi } from 'vitest'
import {
  createGitHubRepositoryHook,
  deleteGitHubRepositoryHook,
  gitHubRepositoryHookMatches,
  githubHookPayload,
  listGitHubRepositoryHooks,
  listGitHubRepositoryHookDeliveries,
  matchingGitHubRepositoryHooks,
  parseGitHubRepositoryHookDeliveryPages,
  parseGitHubRepositoryHookPages,
  pingAndVerifyGitHubRepositoryHook,
  requireMatchingGitHubRepositoryHook,
  sameGitHubEvents,
  triggerGitHubRepositoryHookPing,
  updateGitHubRepositoryHook,
  updateGitHubRepositoryHookEvents,
  type GitHubRepositoryHook,
} from '../../../../scripts/providers/github/repository-hooks'
import { parseGitHubEventSelection } from '../../../../scripts/providers/github/event-profiles'
import { hashSubscriptionSlug } from '../../../../src/lib/subscription'

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

describe('GitHub repository hook deletion', () => {
  it('deletes one exact hook through the versioned API request', async () => {
    const runner = vi.fn(async (_command: string, _args: string[]) => '')
    await deleteGitHubRepositoryHook('example-owner/example-repo', 123, runner)
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]?.[0]).toBe('gh')
    expect(runner.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
      '--method',
      'DELETE',
      'repos/example-owner/example-repo/hooks/123',
      '--silent',
    ]))
    await expect(deleteGitHubRepositoryHook('invalid', 123, runner)).rejects.toThrow(/invalid GitHub repository/)
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

  it('compares the complete managed hook shape', () => {
    const url = `https://hooks.example.com/hook/github/${FIRST_SLUG}`
    expect(gitHubRepositoryHookMatches(hook(1, url, ['star', 'watch']), url, ['watch', 'star'])).toBe(true)
    expect(gitHubRepositoryHookMatches({ ...hook(1, url), active: false }, url, ['push'])).toBe(false)
    expect(gitHubRepositoryHookMatches(hook(1, url), `${url}-different`, ['push'])).toBe(false)
    expect(gitHubRepositoryHookMatches({
      ...hook(1, url),
      config: { url, content_type: 'form', insecure_ssl: '0' },
    }, url, ['push'])).toBe(false)
    expect(gitHubRepositoryHookMatches({
      ...hook(1, url),
      config: { url, content_type: 'json', insecure_ssl: '1' },
    }, url, ['push'])).toBe(false)
  })

  it('creates a hook with a secret-bearing stdin payload and returns its id', async () => {
    const runner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => args.includes('--paginate') ? '[[]]' : '{"id":456}')
    const selection = parseGitHubEventSelection('stars,watchers')
    await expect(createGitHubRepositoryHook(
      'example-owner/example-repo',
      `https://hooks.example.com/hook/github/${FIRST_SLUG}`,
      'local-hmac-secret',
      selection,
      runner,
    )).resolves.toBe(456)

    const [, args, options] = runner.mock.calls[1]!
    expect(args).toContain('POST')
    expect(args).toContain('repos/example-owner/example-repo/hooks')
    expect(args).not.toContain('local-hmac-secret')
    expect(JSON.parse(options!.input!)).toEqual(githubHookPayload(
      `https://hooks.example.com/hook/github/${FIRST_SLUG}`,
      'local-hmac-secret',
      selection,
    ))
  })

  it('PATCHes the exact desired shape and always supplies the secret', async () => {
    const runner = vi.fn(async (
      _command: string,
      _args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => '')
    await updateGitHubRepositoryHook(
      'example-owner/example-repo',
      123,
      `https://hooks.example.com/hook/github/${FIRST_SLUG}`,
      ['star', 'watch'],
      'local-hmac-secret',
      runner,
    )
    const [, args, options] = runner.mock.calls[0]!
    expect(args).toContain('PATCH')
    expect(args).toContain('--silent')
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

describe('GitHub repository hook pings', () => {
  const baseline = {
    id: 10,
    guid: 'baseline-guid',
    event: 'push',
    status_code: 200,
    delivered_at: '2026-08-13T00:00:00Z',
  }
  const pending = {
    id: 11,
    guid: 'pending-guid',
    event: 'ping',
    status_code: null,
    delivered_at: '2026-08-13T00:00:01Z',
  }

  it('parses delivery pages and builds list and ping API calls', async () => {
    expect(parseGitHubRepositoryHookDeliveryPages(JSON.stringify([[baseline]]))).toEqual([{
      id: 'baseline-guid',
      event: 'push',
      statusCode: 200,
      deliveredAt: '2026-08-13T00:00:00Z',
    }])
    expect(() => parseGitHubRepositoryHookDeliveryPages('invalid')).toThrow(/malformed/)
    expect(() => parseGitHubRepositoryHookDeliveryPages('[{}]')).toThrow(/invalid/)

    const runner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => args.includes('GET') ? JSON.stringify([[baseline]]) : '')
    await expect(listGitHubRepositoryHookDeliveries('example-owner/example-repo', 123, runner)).resolves.toHaveLength(1)
    await triggerGitHubRepositoryHookPing('example-owner/example-repo', 123, runner)
    expect(runner.mock.calls[0]![1]).toContain('repos/example-owner/example-repo/hooks/123/deliveries?per_page=100')
    expect(runner.mock.calls[1]![1]).toContain('repos/example-owner/example-repo/hooks/123/pings')
    expect(runner.mock.calls[1]![1]).toContain('--silent')
  })

  it('waits for a new successful ping delivery', async () => {
    let deliveryRead = 0
    let now = 0
    const runner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => {
      if (args.some((arg) => arg.includes('/deliveries'))) {
        deliveryRead += 1
        if (deliveryRead === 1) return JSON.stringify([[baseline]])
        if (deliveryRead === 2) return JSON.stringify([[pending, baseline]])
        return JSON.stringify([[{ ...pending, status_code: 204 }, baseline]])
      }
      return ''
    })
    await expect(pingAndVerifyGitHubRepositoryHook('example-owner/example-repo', 123, runner, {
      timeoutMs: 20,
      intervalMs: 5,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })).resolves.toMatchObject({ id: 'pending-guid', event: 'ping', statusCode: 204 })
  })

  it('rejects a failed ping and times out when no new ping appears', async () => {
    let deliveryRead = 0
    const failedRunner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => {
      if (!args.some((arg) => arg.includes('/deliveries'))) return ''
      deliveryRead += 1
      return deliveryRead === 1
        ? JSON.stringify([[baseline]])
        : JSON.stringify([[{ ...pending, status_code: 500 }, baseline]])
    })
    await expect(pingAndVerifyGitHubRepositoryHook('example-owner/example-repo', 123, failedRunner, {
      timeoutMs: 10,
      intervalMs: 5,
    })).rejects.toThrow(/status 500/)

    let now = 0
    const timeoutRunner = vi.fn(async (
      _command: string,
      args: string[],
      _options?: { input?: string; captureStdout?: boolean },
    ) => args.some((arg) => arg.includes('/deliveries')) ? JSON.stringify([[baseline]]) : '')
    await expect(pingAndVerifyGitHubRepositoryHook('example-owner/example-repo', 123, timeoutRunner, {
      timeoutMs: 10,
      intervalMs: 5,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })).rejects.toThrow(/timed out/)
  })
})
