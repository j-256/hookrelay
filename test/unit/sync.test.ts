import { describe, expect, it } from 'vitest'
import { computePlan, parseRoutes, parseSyncArgs, printableKvKey, validateRoutes } from '../../scripts/sync'
import ROUTES_EXAMPLE from '../../routes.example.jsonc?raw'

const CLAUDE_HASH = 'a'.repeat(64)
const GITHUB_HASH = 'b'.repeat(64)
const EMAIL_HASH = 'c'.repeat(64)

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

const ROTATING_ROUTES = ROUTES.replace(
  '"auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH" }',
  '"auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH", "alternateSecretEnvs": ["HMAC_GH_NEXT"] }',
)

const FILTERED_ROUTES = ROUTES.replace(
  '      "auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH" },',
  `      "auth": { "scheme": "github-sha256", "secretEnv": "HMAC_GH" },
      "filter": {
        "eventTypes": {
          "include": ["pull_request.opened", "pull_request.closed"],
          "exclude": ["pull_request.synchronize"]
        }
      },`,
)

const ACTIVITY_ROUTES = ROUTES.replace(
  '"eventProfiles": ["recommended", "stars"]',
  '"eventProfiles": ["activity"]',
)

const EMAIL_ROUTES = `
{
  "emailBaseAddress": "relay@mail.example.com",
  "subs": [
    {
      "name": "openai-status",
      "source": "email",
      "slugHash": "${EMAIL_HASH}",
      "enabled": true,
      "sinks": ["discord"],
      "fallbackUrl": "https://status.openai.com/",
      "email": {
        "allowedSenders": ["@status.openai.com"],
        "primaryLinkLabels": ["View incident"]
      }
    }
  ],
  "sinks": [
    { "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" }
  ]
}
`

describe('parseSyncArgs', () => {
  it('accepts short and long apply options', () => {
    expect(parseSyncArgs([])).toEqual({ yes: false })
    expect(parseSyncArgs(['-y'])).toEqual({ yes: true })
    expect(parseSyncArgs(['--yes'])).toEqual({ yes: true })
  })

  it('rejects unknown options and positional arguments', () => {
    expect(() => parseSyncArgs(['-x'])).toThrow(/unknown option: -x/)
    expect(() => parseSyncArgs(['extra'])).toThrow(/unknown option: extra/)
  })
})

describe('parseRoutes', () => {
  it('parses JSONC with comments', () => {
    const cfg = parseRoutes(`// header\n${ROUTES}`)
    expect(cfg.subs).toHaveLength(2)
    expect(cfg.sinks).toHaveLength(1)
    expect(cfg.baseUrl).toBe('https://hooks.example.com')
  })

  it('keeps the portable example parseable and documents guarded notification links', () => {
    expect(parseRoutes(ROUTES_EXAMPLE)).toMatchObject({ subs: [], sinks: [] })
    expect(ROUTES_EXAMPLE).toContain('"fallbackUrl"')
    expect(ROUTES_EXAMPLE).toContain('"primaryLinkLabels"')
    expect(ROUTES_EXAMPLE).toContain('"eventTypes"')
  })

  it('throws on malformed JSON', () => {
    expect(() => parseRoutes('{ "subs": [')).toThrow(/parse/i)
  })

  it('rejects raw subscription slugs', () => {
    expect(() => parseRoutes(ROUTES.replace(`"slugHash": "${CLAUDE_HASH}"`, '"slug": "abcdefghijabcdefghijab"'))).toThrow()
  })

  it('parses alternate subscription secret environments', () => {
    const cfg = parseRoutes(ROTATING_ROUTES)
    expect(cfg.subs[1]?.auth).toEqual({
      scheme: 'github-sha256',
      secretEnv: 'HMAC_GH',
      alternateSecretEnvs: ['HMAC_GH_NEXT'],
    })
  })

  it('parses email ingress configuration', () => {
    const cfg = parseRoutes(EMAIL_ROUTES)
    expect(cfg.emailBaseAddress).toBe('relay@mail.example.com')
    expect(cfg.subs[0]?.fallbackUrl).toBe('https://status.openai.com/')
    expect(cfg.subs[0]?.email).toEqual({
      allowedSenders: ['@status.openai.com'],
      primaryLinkLabels: ['View incident'],
    })
    expect(cfg.subs[0]?.auth).toBeNull()
  })

  it('parses source-independent event type filters', () => {
    const cfg = parseRoutes(FILTERED_ROUTES)
    expect(cfg.subs[1]?.filter).toEqual({
      eventTypes: {
        include: ['pull_request.opened', 'pull_request.closed'],
        exclude: ['pull_request.synchronize'],
      },
    })
  })

  it('rejects empty filters and invalid wildcard placement', () => {
    expect(() => parseRoutes(FILTERED_ROUTES.replace(
      '"include": ["pull_request.opened", "pull_request.closed"],',
      '"include": [],',
    ))).toThrow()
    expect(() => parseRoutes(FILTERED_ROUTES.replace(
      'pull_request.opened',
      'pull_*_opened',
    ))).toThrow()
    expect(() => parseRoutes(FILTERED_ROUTES.replace(
      `"include": ["pull_request.opened", "pull_request.closed"],
          "exclude": ["pull_request.synchronize"]`,
      '',
    ))).toThrow(/include or exclude/)
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

  it('accepts rotating auth when every referenced secret is available', () => {
    const cfg = parseRoutes(ROTATING_ROUTES)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH', 'HMAC_GH_NEXT']),
    })
    expect(issues).toEqual([])
  })

  it('reports every missing rotating auth secret', () => {
    const cfg = parseRoutes(ROTATING_ROUTES)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(),
    })
    expect(issues).toContain("sub 'gh': secret HMAC_GH not set in Wrangler")
    expect(issues).toContain("sub 'gh': secret HMAC_GH_NEXT not set in Wrangler")
  })

  it('rejects duplicate rotating auth references', () => {
    const cfg = parseRoutes(ROTATING_ROUTES.replace('HMAC_GH_NEXT', 'HMAC_GH'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues.join('\n')).toMatch(/secret references must be unique/)
  })

  it('rejects rotating auth on a non-GitHub subscription', () => {
    const cfg = parseRoutes(ROTATING_ROUTES.replace('"source": "github"', '"source": "statuspage"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH', 'HMAC_GH_NEXT']),
    })
    expect(issues.join('\n')).toMatch(/only valid for GitHub subscriptions/)
  })

  it('rejects rotating auth with a non-GitHub scheme', () => {
    const cfg = parseRoutes(ROTATING_ROUTES.replace('github-sha256', 'shared-secret'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH', 'HMAC_GH_NEXT']),
    })
    expect(issues.join('\n')).toMatch(/requires the github-sha256 scheme/)
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

  it('reports duplicate event type filter patterns', () => {
    const cfg = parseRoutes(FILTERED_ROUTES.replace('pull_request.closed', 'pull_request.opened'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues).toContain("sub 'gh': duplicate event type include pattern")
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

  it('validates email base addresses and sender rules', () => {
    const cfg = parseRoutes(EMAIL_ROUTES.replace(
      '"@status.openai.com"',
      '"@status.openai.com", "@status.openai.com", "not-an-address"',
    ))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['email']),
      knownSinkTypes: new Set(['discord']),
      sinkSchemas: { discord: { urlEnv: 'string' } } as any,
      secretsAvailable: new Set(['SINK_DISCORD_URL']),
    })
    expect(issues).toContain("sub 'openai-status': duplicate email sender rule: @status.openai.com")
    expect(issues.join('\n')).toMatch(/invalid sender address rule/)
  })

  it('validates fallback URLs and email primary link labels', () => {
    const invalidFallback = parseRoutes(EMAIL_ROUTES.replace(
      'https://status.openai.com/',
      'https://status.openai.com/?token=opaque',
    ))
    const duplicateLabels = parseRoutes(EMAIL_ROUTES.replace(
      '["View incident"]',
      '["View incident", " view  incident "]',
    ))
    const context = {
      knownSources: new Set(['email']),
      knownSinkTypes: new Set(['discord']),
      sinkSchemas: { discord: { urlEnv: 'string' } } as any,
      secretsAvailable: new Set(['SINK_DISCORD_URL']),
    }

    expect(validateRoutes(invalidFallback, context).join('\n')).toMatch(/must not contain.*query/)
    expect(validateRoutes(duplicateLabels, context).join('\n')).toMatch(/duplicate email primary link label/)
  })

  it('requires email metadata only on email subscriptions', () => {
    const missingEmail = parseRoutes(EMAIL_ROUTES.replace(
      `,
      "email": {
        "allowedSenders": ["@status.openai.com"],
        "primaryLinkLabels": ["View incident"]
      }`,
      '',
    ))
    const wrongSource = parseRoutes(EMAIL_ROUTES.replace('"source": "email"', '"source": "statuspage"'))
    const context = {
      knownSources: new Set(['email', 'statuspage']),
      knownSinkTypes: new Set(['discord']),
      sinkSchemas: { discord: { urlEnv: 'string' } } as any,
      secretsAvailable: new Set(['SINK_DISCORD_URL']),
    }
    expect(validateRoutes(missingEmail, context).join('\n')).toMatch(/require email configuration/)
    expect(validateRoutes(wrongSource, context).join('\n')).toMatch(/only valid for email subscriptions/)
  })

  it('requires a valid email base address for email subscriptions', () => {
    const missingBase = parseRoutes(EMAIL_ROUTES.replace(
      '  "emailBaseAddress": "relay@mail.example.com",\n',
      '',
    ))
    const invalidBase = parseRoutes(EMAIL_ROUTES.replace('relay@mail.example.com', 'relay+tag@mail.example.com'))
    const context = {
      knownSources: new Set(['email']),
      knownSinkTypes: new Set(['discord']),
      sinkSchemas: { discord: { urlEnv: 'string' } } as any,
      secretsAvailable: new Set(['SINK_DISCORD_URL']),
    }
    expect(validateRoutes(missingBase, context).join('\n')).toMatch(/require emailBaseAddress/)
    expect(validateRoutes(invalidBase, context).join('\n')).toMatch(/emailBaseAddress is invalid/)
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

  it('serializes alternate subscription secret environments', () => {
    const cfg = parseRoutes(ROTATING_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value).auth).toEqual({
      scheme: 'github-sha256',
      secretEnv: 'HMAC_GH',
      alternateSecretEnvs: ['HMAC_GH_NEXT'],
    })
  })

  it('serializes event filters into runtime subscription configuration', () => {
    const cfg = parseRoutes(FILTERED_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value).filter).toEqual({
      eventTypes: {
        include: ['pull_request.opened', 'pull_request.closed'],
        exclude: ['pull_request.synchronize'],
      },
    })
  })

  it('compiles shared GitHub profile filters without per-repository route configuration', () => {
    const cfg = parseRoutes(ACTIVITY_ROUTES)
    expect(cfg.subs[1]?.filter).toBeUndefined()
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value).filter).toEqual({
      eventTypes: {
        include: [
          'push.*',
          'workflow_run.*',
          'pull_request.opened',
          'pull_request.closed',
        ],
      },
    })
  })

  it('serializes email sender rules into runtime subscription configuration', () => {
    const cfg = parseRoutes(EMAIL_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    expect(JSON.parse(plan.subPuts[0]!.value)).toEqual({
      name: 'openai-status',
      source: 'email',
      enabled: true,
      sinks: ['discord'],
      auth: null,
      fallbackUrl: 'https://status.openai.com/',
      email: {
        allowedSenders: ['@status.openai.com'],
        primaryLinkLabels: ['view incident'],
      },
    })
  })
})

describe('printableKvKey', () => {
  it('redacts legacy raw-slug keys but leaves hashes and sink names visible', () => {
    expect(printableKvKey('sub:raw-bearer-value-aaaa')).toBe('sub:<legacy-redacted>')
    expect(printableKvKey(`sub:sha256:${CLAUDE_HASH}`)).toBe(`sub:sha256:${CLAUDE_HASH}`)
    expect(printableKvKey('sink:discord')).toBe('sink:discord')
  })
})
