// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { hashSubscriptionSlug } from '../../../../src/lib/subscription'
import type { GitHubRepositoryHook } from '../../../../scripts/providers/github/repository-hooks'
import {
  applyGitHubEventSync,
  formatGitHubEventSyncPlan,
  parseGitHubEventSyncArgs,
  planGitHubEventSync,
} from '../../../../scripts/providers/github/sync-events'

const REPO = 'example-owner/example-repo'
const STAR_SLUG = 'abcdefghijklmnopqrstuv'
const ALERT_SLUG = 'zyxwvutsrqponmlkjihgfe'
const SECRET = 'fixture-private-hmac'

function hook(id: number, slug: string, events: string[]): GitHubRepositoryHook {
  return {
    id,
    active: true,
    events,
    config: {
      url: `https://hooks.example.com/hook/github/${slug}`,
      content_type: 'json',
      insecure_ssl: '0',
    },
  }
}

async function fixture() {
  const hooks = [
    hook(1, STAR_SLUG, ['star', 'watch']),
    hook(2, ALERT_SLUG, ['dependabot_alert']),
    hook(3, 'otherprivatehookslug123', ['push']),
  ]
  const routesText = JSON.stringify({
    subs: [
      {
        name: `github:${REPO}:stars`,
        source: 'github',
        slugHash: await hashSubscriptionSlug(STAR_SLUG),
        enabled: true,
        sinks: ['discord:github-stars'],
        auth: { scheme: 'github-sha256', secretEnv: 'HMAC_REPO' },
        setup: { github: { repo: REPO, eventProfiles: ['stars'] } },
      },
      {
        name: `github:${REPO}:alerts`,
        source: 'github',
        slugHash: await hashSubscriptionSlug(ALERT_SLUG),
        enabled: true,
        sinks: ['discord:repo-alerts'],
        auth: { scheme: 'github-sha256', secretEnv: 'HMAC_REPO' },
        setup: { github: { repo: REPO, eventProfiles: ['alerts'] } },
      },
    ],
    sinks: [],
  })
  return { hooks, routesText, devVarsText: `HMAC_REPO=${SECRET}\n` }
}

describe('GitHub event sync', () => {
  it('previews only drifted hooks from saved subscriptions without exposing private values', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    const listHooks = vi.fn(async () => hooks)
    const plan = await planGitHubEventSync(routesText, devVarsText, listHooks)

    expect(listHooks).toHaveBeenCalledOnce()
    expect(plan.checked).toBe(2)
    expect(plan.changes.map((change) => ({ name: change.name, before: change.before.events, after: change.events }))).toEqual([
      { name: `github:${REPO}:stars`, before: ['star', 'watch'], after: ['star'] },
      { name: `github:${REPO}:alerts`, before: ['dependabot_alert'], after: ['code_scanning_alert', 'dependabot_alert', 'secret_scanning_alert'] },
    ])
    expect(plan.providerScope.puts).toHaveLength(2)
    expect(plan.providerScope.puts?.every((put) => put.policyFields?.join(',') === 'filter')).toBe(true)
    const output = formatGitHubEventSyncPlan(plan)
    expect(output).toContain(`github:${REPO}:stars`)
    expect(output).not.toContain(SECRET)
    expect(output).not.toContain(STAR_SLUG)
    expect(output).not.toContain('https://hooks.example.com')
  })

  it('rejects missing hooks and secrets before applying any provider or GitHub change', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    await expect(planGitHubEventSync(routesText, devVarsText, async () => hooks.slice(1)))
      .rejects.toThrow(/matching GitHub webhook not found/)
    await expect(planGitHubEventSync(routesText, '', async () => hooks))
      .rejects.toThrow(/HMAC_REPO is missing from .dev.vars/)
  })

  it('applies provider filters first, updates exact changed hooks, and verifies the result', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    const listHooks = vi.fn(async () => hooks.map((current) => ({ ...current, events: [...current.events] })))
    const plan = await planGitHubEventSync(routesText, devVarsText, listHooks)
    const order: string[] = []
    const syncProvider = vi.fn(async (apply: boolean) => { order.push(`provider:${apply}`) })
    const updateHook = vi.fn(async (_repo: string, current: GitHubRepositoryHook, events: readonly string[], secret: string) => {
      expect(secret).toBe(SECRET)
      order.push(`hook:${current.id}`)
      hooks.find((candidate) => candidate.id === current.id)!.events = [...events]
    })

    const result = await applyGitHubEventSync(plan, { listHooks, syncProvider, updateHook })
    expect(result.updated).toBe(2)
    expect(order).toEqual(['provider:true', 'hook:1', 'hook:2'])
    expect(hooks[0]!.events).toEqual(['star'])
    expect(hooks[1]!.events).toEqual(['code_scanning_alert', 'dependabot_alert', 'secret_scanning_alert'])
    expect(hooks[2]!.events).toEqual(['push'])
  })

  it('refuses to apply a stale preview before changing provider configuration', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    const listHooks = async () => hooks
    const plan = await planGitHubEventSync(routesText, devVarsText, listHooks)
    hooks[0]!.events = ['star', 'fork']
    const syncProvider = vi.fn(async () => undefined)
    const updateHook = vi.fn(async () => undefined)

    await expect(applyGitHubEventSync(plan, { listHooks, syncProvider, updateHook }))
      .rejects.toThrow(/changed since preview/)
    expect(syncProvider).not.toHaveBeenCalled()
    expect(updateHook).not.toHaveBeenCalled()
  })

  it('reports a partial GitHub failure so a later preview can resume safely', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    const listHooks = async () => hooks
    const plan = await planGitHubEventSync(routesText, devVarsText, listHooks)
    const syncProvider = vi.fn(async () => undefined)
    const updateHook = vi.fn(async (_repo: string, current: GitHubRepositoryHook, events: readonly string[]) => {
      if (current.id === 2) throw new Error('fixture API failure')
      hooks[0]!.events = [...events]
    })

    await expect(applyGitHubEventSync(plan, { listHooks, syncProvider, updateHook }))
      .rejects.toThrow(/github:example-owner\/example-repo:alerts: GitHub update failed after 1\/2 hooks/)
    expect(syncProvider).toHaveBeenCalledOnce()
    const retry = await planGitHubEventSync(routesText, devVarsText, listHooks)
    expect(retry.changes.map((change) => change.name)).toEqual([`github:${REPO}:alerts`])
  })

  it('rejects a hook whose configuration changed during the update', async () => {
    const { hooks, routesText, devVarsText } = await fixture()
    const listHooks = async () => hooks
    const plan = await planGitHubEventSync(routesText, devVarsText, listHooks)
    const syncProvider = vi.fn(async () => undefined)
    const updateHook = vi.fn(async (_repo: string, current: GitHubRepositoryHook, events: readonly string[]) => {
      const changed = hooks.find((candidate) => candidate.id === current.id)!
      changed.events = [...events]
      if (current.id === 2) changed.active = false
    })

    await expect(applyGitHubEventSync(plan, { listHooks, syncProvider, updateHook }))
      .rejects.toThrow(/did not match after 2 updates/)
  })

  it('accepts preview or explicit apply and rejects unrelated options', () => {
    expect(parseGitHubEventSyncArgs([])).toEqual({ yes: false })
    expect(parseGitHubEventSyncArgs(['-y'])).toEqual({ yes: true })
    expect(parseGitHubEventSyncArgs(['--yes'])).toEqual({ yes: true })
    expect(parseGitHubEventSyncArgs(['-yh'])).toEqual({ yes: true, help: true })
    expect(parseGitHubEventSyncArgs(['--'])).toEqual({ yes: false })
    expect(() => parseGitHubEventSyncArgs(['--repo', REPO])).toThrow(/unknown option/)
  })
})
