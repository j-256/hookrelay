import { describe, expect, it, vi } from 'vitest'
import {
  computeLifecyclePlan,
  managedLifecycleRule,
  MANAGED_RETENTION_RULE_ID,
  parseRetentionArgs,
  parseRetentionSettings,
  runRetentionCommand,
  type LifecycleRule,
  type RetentionDependencies,
} from '../../scripts/retention'

const ROUTES = `{
  "retention": { "r2Days": 30, "d1Days": 90 },
  "subs": [],
  "sinks": []
}`

const WRANGLER = `{
  // The binding selects the managed raw-event bucket
  "r2_buckets": [
    { "binding": "EVENTS_RAW", "bucket_name": "hookrelay-raw" }
  ]
}`

const unrelatedRule: LifecycleRule = {
  id: 'abort-multipart',
  enabled: true,
  conditions: {},
  abortMultipartUploadsTransition: {
    condition: { type: 'Age', maxAge: 604800 },
  },
}

function response(rules: LifecycleRule[]): Response {
  return Response.json({ success: true, result: { rules } })
}

function dependencies(fetchFn: typeof fetch): RetentionDependencies & {
  logs: string[]
  confirmMock: ReturnType<typeof vi.fn>
} {
  const logs: string[] = []
  const confirmMock = vi.fn(async () => true)
  return {
    fetch: fetchFn,
    readText: async (path) => path === 'routes.jsonc' ? ROUTES : WRANGLER,
    confirm: confirmMock,
    environment: {
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'private-token',
    },
    log: (line) => logs.push(line),
    logs,
    confirmMock,
  }
}

describe('retention command', () => {
  it('parses phases and limits noninteractive approval to apply', () => {
    expect(parseRetentionArgs(['plan'])).toEqual({ phase: 'plan', yes: false })
    expect(parseRetentionArgs(['apply', '-y'])).toEqual({ phase: 'apply', yes: true })
    expect(() => parseRetentionArgs(['verify', '--yes'])).toThrow(/apply/)
  })

  it('reads the configured lifetimes and EVENTS_RAW bucket', () => {
    expect(parseRetentionSettings(ROUTES, WRANGLER)).toEqual({
      bucketName: 'hookrelay-raw',
      r2Days: 30,
      d1Days: 90,
    })
  })

  it('replaces only the stable managed rule and preserves unrelated rules', () => {
    const staleManaged: LifecycleRule = {
      ...managedLifecycleRule(10),
      enabled: false,
    }
    const plan = computeLifecyclePlan(
      'hookrelay-raw',
      30,
      [unrelatedRule, staleManaged],
    )
    expect(plan.currentState).toBe('drifted')
    expect(plan.changed).toBe(true)
    expect(plan.desiredRules).toEqual([unrelatedRule, managedLifecycleRule(30)])
    expect(plan.desiredRules[0]).toBe(unrelatedRule)
  })

  it('plans with a read-only authenticated GET and secret-free output', async () => {
    const fetchMock = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => response([unrelatedRule]))
    const deps = dependencies(fetchMock as typeof fetch)

    await expect(runRetentionCommand({ phase: 'plan', yes: false }, deps)).resolves.toBe('planned')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/accounts/account-id/r2/buckets/hookrelay-raw/lifecycle')
    expect(init?.method).toBeUndefined()
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-token')
    expect(deps.logs.join('\n')).not.toContain('private-token')
    expect(deps.confirmMock).not.toHaveBeenCalled()
  })

  it('applies a reviewed replacement and verifies the exact remote result', async () => {
    let remoteRules: LifecycleRule[] = [unrelatedRule, managedLifecycleRule(10)]
    const fetchMock = vi.fn(async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (init?.method === 'PUT') {
        remoteRules = (JSON.parse(String(init.body)) as { rules: LifecycleRule[] }).rules
        return Response.json({ success: true, result: {} })
      }
      return response(remoteRules)
    })
    const deps = dependencies(fetchMock as typeof fetch)

    await expect(runRetentionCommand({ phase: 'apply', yes: false }, deps)).resolves.toBe('applied')
    expect(deps.confirmMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(remoteRules).toEqual([unrelatedRule, managedLifecycleRule(30)])
    expect(remoteRules.filter((rule) => rule.id === MANAGED_RETENTION_RULE_ID)).toHaveLength(1)
  })

  it('does not mutate when apply confirmation is declined', async () => {
    const fetchMock = vi.fn(async () => response([]))
    const deps = dependencies(fetchMock as typeof fetch)
    deps.confirmMock.mockResolvedValue(false)

    await expect(runRetentionCommand({ phase: 'apply', yes: false }, deps)).resolves.toBe('cancelled')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fails verification for drift without issuing a write', async () => {
    const fetchMock = vi.fn(async () => response([managedLifecycleRule(10)]))
    const deps = dependencies(fetchMock as typeof fetch)

    await expect(runRetentionCommand({ phase: 'verify', yes: false }, deps)).rejects.toThrow(/does not match/)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('removes only the managed rule when R2 retention is omitted', async () => {
    let remoteRules: LifecycleRule[] = [unrelatedRule, managedLifecycleRule(30)]
    const fetchMock = vi.fn(async (
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (init?.method === 'PUT') {
        remoteRules = (JSON.parse(String(init.body)) as { rules: LifecycleRule[] }).rules
        return Response.json({ success: true, result: {} })
      }
      return response(remoteRules)
    })
    const deps = dependencies(fetchMock as typeof fetch)
    deps.readText = async (path) => path === 'routes.jsonc'
      ? '{ "retention": { "d1Days": 90 }, "subs": [], "sinks": [] }'
      : WRANGLER

    await expect(runRetentionCommand({ phase: 'apply', yes: true }, deps)).resolves.toBe('applied')
    expect(remoteRules).toEqual([unrelatedRule])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
