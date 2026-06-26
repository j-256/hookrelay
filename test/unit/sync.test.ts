import { describe, expect, it } from 'vitest'
import { computePlan, parseRoutes, validateRoutes } from '../../scripts/sync'

const ROUTES = `
{
  "subs": [
    {
      "name": "claude",
      "source": "statuspage",
      "slug": "abcdefghijabcdefghijab",
      "enabled": true,
      "sinks": ["phone"]
    },
    {
      "name": "gh",
      "source": "github",
      "slug": "1234567890abcdef123456",
      "enabled": true,
      "sinks": ["phone"],
      "auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH" }
    }
  ],
  "sinks": [
    { "name": "phone", "type": "ntfy", "topic": "test-topic" }
  ]
}
`

describe('parseRoutes', () => {
  it('parses JSONC with comments', () => {
    const cfg = parseRoutes(`// header\n${ROUTES}`)
    expect(cfg.subs).toHaveLength(2)
    expect(cfg.sinks).toHaveLength(1)
  })

  it('throws on malformed JSON', () => {
    expect(() => parseRoutes('{ "subs": [')).toThrow(/parse/i)
  })
})

describe('validateRoutes', () => {
  it('passes when sinks referenced by subs exist and required secrets are set', () => {
    const cfg = parseRoutes(ROUTES)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues).toEqual([])
  })

  it('reports unknown source', () => {
    const cfg = parseRoutes(ROUTES.replace('"statuspage"', '"made-up"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/unknown source: made-up/)
  })

  it('reports sub referencing missing sink', () => {
    const cfg = parseRoutes(ROUTES.replace('"phone"', '"missing"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/sink 'missing' not declared/)
  })

  it('reports missing secret for sub auth', () => {
    const cfg = parseRoutes(ROUTES)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(),
    })
    expect(issues.join('\n')).toMatch(/secret HMAC_GH not set/)
  })

  it('reports unknown sink type', () => {
    const cfg = parseRoutes(ROUTES.replace('"ntfy"', '"madeup-sink"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/unknown sink type: madeup-sink/)
  })

  it('reports duplicate sub slugs', () => {
    const dup = ROUTES.replace('1234567890abcdef123456', 'abcdefghijabcdefghijab')
    const cfg = parseRoutes(dup)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/duplicate sub slug/)
  })
})

describe('computePlan', () => {
  it('emits puts for new keys, updates for changed keys, deletes for stale keys', () => {
    const cfg = parseRoutes(ROUTES)
    const plan = computePlan(cfg, {
      subs: {
        // existing key with stale value -> update
        'sub:abcdefghijabcdefghijab': '{"name":"claude","source":"statuspage","enabled":false,"sinks":["phone"],"auth":null}',
        // existing key not in file -> delete
        'sub:obsolete-slug-aaaaaa': '{}',
      },
      sinks: {
        // matches file exactly -> no-op
        'sink:phone': '{"type":"ntfy","topic":"test-topic"}',
      },
    })
    expect(plan.subPuts).toHaveLength(2) // claude updated, gh new
    expect(plan.subDeletes).toEqual(['sub:obsolete-slug-aaaaaa'])
    expect(plan.sinkPuts).toHaveLength(0)
    expect(plan.sinkDeletes).toEqual([])
  })
})
