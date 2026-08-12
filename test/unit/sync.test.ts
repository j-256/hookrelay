import { describe, expect, it } from 'vitest'
import { computePlan, parseRoutes, printableKvKey, validateRoutes } from '../../scripts/sync'

const CLAUDE_HASH = 'a'.repeat(64)
const GITHUB_HASH = 'b'.repeat(64)

const ROUTES = `
{
  "baseUrl": "https://hooks.example.com",
  "subs": [
    {
      "name": "claude",
      "source": "statuspage",
      "slugHash": "${CLAUDE_HASH}",
      "enabled": true,
      "sinks": ["phone"]
    },
    {
      "name": "gh",
      "source": "github",
      "slugHash": "${GITHUB_HASH}",
      "enabled": true,
      "sinks": ["phone"],
      "auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH" },
      "setup": {
        "github": {
          "repo": "example-owner/example-repo",
          "eventProfiles": ["recommended", "stars"]
        }
      }
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
    expect(cfg.baseUrl).toBe('https://hooks.example.com')
  })

  it('throws on malformed JSON', () => {
    expect(() => parseRoutes('{ "subs": [')).toThrow(/parse/i)
  })

  it('rejects raw subscription slugs', () => {
    expect(() => parseRoutes(ROUTES.replace(`"slugHash": "${CLAUDE_HASH}"`, '"slug": "abcdefghijabcdefghijab"'))).toThrow()
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

  it('reports missing secret for an authenticated ntfy sink', () => {
    const cfg = parseRoutes(
      ROUTES.replace('"topic": "test-topic"', '"topic": "test-topic", "tokenEnv": "SINK_NTFY_PHONE_TOKEN"'),
    )
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/secret SINK_NTFY_PHONE_TOKEN .* not set/)
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

  it('reports duplicate sub slug hashes', () => {
    const dup = ROUTES.replace(GITHUB_HASH, CLAUDE_HASH)
    const cfg = parseRoutes(dup)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/duplicate sub slugHash/)
  })

  it('reports invalid local GitHub setup metadata', () => {
    const cfg = parseRoutes(ROUTES.replace('"recommended", "stars"', '"all", "stars"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/invalid setup\.github\.eventProfiles/)
  })
})

describe('computePlan', () => {
  it('emits puts for new keys, updates for changed keys, deletes for stale keys', () => {
    const cfg = parseRoutes(ROUTES)
    const plan = computePlan(cfg, {
      subs: {
        // existing key with stale value -> update
        [`sub:sha256:${CLAUDE_HASH}`]: '{"name":"claude","source":"statuspage","enabled":false,"sinks":["phone"],"auth":null}',
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
    expect(plan.subPuts.map((entry) => entry.key)).toEqual([
      `sub:sha256:${CLAUDE_HASH}`,
      `sub:sha256:${GITHUB_HASH}`,
    ])
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value)).not.toHaveProperty('setup')
    expect(plan.sinkPuts).toHaveLength(0)
    expect(plan.sinkDeletes).toEqual([])
  })
})

describe('printableKvKey', () => {
  it('redacts legacy raw-slug keys but leaves hashes and sink names visible', () => {
    expect(printableKvKey('sub:raw-bearer-value-aaaa')).toBe('sub:<legacy-redacted>')
    expect(printableKvKey(`sub:sha256:${CLAUDE_HASH}`)).toBe(`sub:sha256:${CLAUDE_HASH}`)
    expect(printableKvKey('sink:discord')).toBe('sink:discord')
  })
})
