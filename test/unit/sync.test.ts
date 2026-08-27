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

const SINK_POLICY_ROUTES = FILTERED_ROUTES.replace(
  '      "sinks": ["phone"],\n      "auth":',
  `      "sinks": ["phone"],
      "sinkFilters": {
        "phone": {
          "eventTypes": { "include": ["pull_request.*"] },
          "severities": { "include": ["error", "critical"] }
        }
      },
      "auth":`,
)

const CLOUDEVENTS_ROUTES = `
{
  "subs": [
    {
      "name": "automation",
      "source": "cloudevents",
      "slugHash": "${CLAUDE_HASH}",
      "enabled": true,
      "sinks": ["outbound"],
      "auth": {
        "scheme": "hookrelay-sha256",
        "secretEnv": "HMAC_AUTOMATION",
        "alternateSecretEnvs": ["HMAC_AUTOMATION_NEXT"]
      }
    }
  ],
  "sinks": [
    {
      "name": "outbound",
      "type": "webhook",
      "urlEnv": "SINK_OUTBOUND_URL",
      "signingSecretEnv": "SINK_OUTBOUND_SIGNING_SECRET"
    }
  ]
}
`

const ACTIVITY_ROUTES = ROUTES.replace(
  '"eventProfiles": ["recommended", "stars"]',
  '"eventProfiles": ["activity"]',
)

const PUSH_ROUTES = ROUTES.replace(
  '"eventProfiles": ["recommended", "stars"]',
  '"eventProfiles": ["push"]',
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

const OPERATIONS_ROUTES = ROUTES.replace(
  '  "subs": [',
  `  "operations": {
    "sinks": ["phone"],
    "alertCooldownMinutes": 60,
    "staleDeliveryMinutes": 15
  },
  "retention": {
    "r2Days": 30,
    "d1Days": 90
  },
  "subs": [`,
)

const RETIRED_SINK_ROUTES = `
{
  "subs": [
    {
      "name": "disabled",
      "source": "statuspage",
      "slugHash": "${CLAUDE_HASH}",
      "enabled": false,
      "sinks": ["retiring"]
    }
  ],
  "sinks": [],
  "retiredSinks": [
    { "name": "retiring", "type": "ntfy", "topic": "retained-topic" }
  ]
}
`

describe('parseSyncArgs', () => {
  it('accepts short and long apply options', () => {
    expect(parseSyncArgs([])).toEqual({ yes: false })
    expect(parseSyncArgs(['-y'])).toEqual({ yes: true })
    expect(parseSyncArgs(['--yes'])).toEqual({ yes: true })
    expect(parseSyncArgs(['--routes', '/secure/routes.jsonc'])).toEqual({
      routes: '/secure/routes.jsonc',
      yes: false,
    })
  })

  it('rejects unknown options and positional arguments', () => {
    expect(() => parseSyncArgs(['-x'])).toThrow(/unknown option: -x/)
    expect(() => parseSyncArgs(['extra'])).toThrow(/unknown option: extra/)
    expect(() => parseSyncArgs(['--routes'])).toThrow(/requires a value/)
    expect(() => parseSyncArgs(['--routes', 'one', '--routes', 'two'])).toThrow(/only be supplied once/)
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

  it('parses per-sink event type and severity filters', () => {
    const cfg = parseRoutes(SINK_POLICY_ROUTES)
    expect(cfg.subs[1]?.sinkFilters).toEqual({
      phone: {
        eventTypes: { include: ['pull_request.*'] },
        severities: { include: ['error', 'critical'] },
      },
    })
  })

  it('parses rotating CloudEvents auth and signed webhook references', () => {
    const cfg = parseRoutes(CLOUDEVENTS_ROUTES)
    expect(cfg.subs[0]?.auth).toEqual({
      scheme: 'hookrelay-sha256',
      secretEnv: 'HMAC_AUTOMATION',
      alternateSecretEnvs: ['HMAC_AUTOMATION_NEXT'],
    })
    expect(cfg.sinks[0]).toMatchObject({
      type: 'webhook',
      urlEnv: 'SINK_OUTBOUND_URL',
      signingSecretEnv: 'SINK_OUTBOUND_SIGNING_SECRET',
    })
  })

  it('parses operations and retention configuration', () => {
    const cfg = parseRoutes(OPERATIONS_ROUTES)
    expect(cfg.operations).toEqual({
      sinks: ['phone'],
      alertCooldownMinutes: 60,
      staleDeliveryMinutes: 15,
    })
    expect(cfg.retention).toEqual({ r2Days: 30, d1Days: 90 })
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

  it('requires operations sinks to be declared and unique', () => {
    const invalid = OPERATIONS_ROUTES
      .replace('"sinks": ["phone"]', '"sinks": ["missing", "missing"]')
    const issues = validateRoutes(parseRoutes(invalid), {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues).toContain('operations: unknown sink: missing')
    expect(issues).toContain('operations: duplicate sink: missing')
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

  it('allows disabled subscriptions to retain retired sinks but blocks active use', () => {
    const context = {
      knownSources: new Set(['statuspage']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { safeParse: () => ({ success: true }) } as any },
      secretsAvailable: new Set<string>(),
    }
    expect(validateRoutes(parseRoutes(RETIRED_SINK_ROUTES), context)).toEqual([])
    const enabled = parseRoutes(RETIRED_SINK_ROUTES.replace('"enabled": false', '"enabled": true'))
    expect(validateRoutes(enabled, context)).toContain(
      "sub 'disabled': enabled subscriptions cannot reference retired sink 'retiring'",
    )
    const operations = parseRoutes(RETIRED_SINK_ROUTES.replace(
      '  "subs":',
      '  "operations": { "sinks": ["retiring"], "alertCooldownMinutes": 60, "staleDeliveryMinutes": 15 },\n  "subs":',
    ))
    expect(validateRoutes(operations, context)).toContain('operations: unknown sink: retiring')
  })

  it('requires sink names to be unique across active and retired collections', () => {
    const duplicate = parseRoutes(RETIRED_SINK_ROUTES.replace(
      '"sinks": []',
      '"sinks": [{ "name": "retiring", "type": "ntfy", "topic": "duplicate" }]',
    ))
    const issues = validateRoutes(duplicate, {
      knownSources: new Set(['statuspage']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { safeParse: () => ({ success: true }) } as any },
      secretsAvailable: new Set<string>(),
    })
    expect(issues).toContain("sink 'retiring': declared as both active and retired")
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
    expect(issues.join('\n')).toMatch(/only valid for rotating HMAC subscriptions/)
  })

  it('rejects rotating auth with a non-GitHub scheme', () => {
    const cfg = parseRoutes(ROTATING_ROUTES.replace('github-sha256', 'shared-secret'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH', 'HMAC_GH_NEXT']),
    })
    expect(issues.join('\n')).toMatch(/requires an HMAC-SHA256 scheme/)
  })

  it('accepts CloudEvents secret rotation and validates both webhook secrets', () => {
    const cfg = parseRoutes(CLOUDEVENTS_ROUTES)
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['cloudevents']),
      knownSinkTypes: new Set(['webhook']),
      sinkSchemas: {
        webhook: {
          safeParse: () => ({ success: true }),
        } as any,
      },
      secretsAvailable: new Set([
        'HMAC_AUTOMATION',
        'HMAC_AUTOMATION_NEXT',
        'SINK_OUTBOUND_URL',
        'SINK_OUTBOUND_SIGNING_SECRET',
      ]),
    })
    expect(issues).toEqual([])
  })

  it('requires the CloudEvents HMAC scheme', () => {
    const cfg = parseRoutes(CLOUDEVENTS_ROUTES.replace('hookrelay-sha256', 'github-sha256'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['cloudevents']),
      knownSinkTypes: new Set(['webhook']),
      sinkSchemas: {},
      secretsAvailable: new Set([
        'HMAC_AUTOMATION',
        'HMAC_AUTOMATION_NEXT',
        'SINK_OUTBOUND_URL',
        'SINK_OUTBOUND_SIGNING_SECRET',
      ]),
    })
    expect(issues.join('\n')).toMatch(/require the hookrelay-sha256 scheme/)
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
    expect(issues).toContain("sub 'gh' subscription: duplicate event type include pattern")
  })

  it('rejects sink filters for sinks not selected by the subscription', () => {
    const cfg = parseRoutes(SINK_POLICY_ROUTES.replace('"phone": {', '"missing": {'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues).toContain("sub 'gh': sink filter 'missing' is not listed in sinks[]")
  })

  it('reports duplicate per-sink severity values', () => {
    const cfg = parseRoutes(SINK_POLICY_ROUTES.replace('"error", "critical"', '"error", "error"'))
    const issues = validateRoutes(cfg, {
      knownSources: new Set(['statuspage', 'github']),
      knownSinkTypes: new Set(['ntfy']),
      sinkSchemas: { ntfy: { topic: 'string' } } as any,
      secretsAvailable: new Set(['HMAC_GH']),
    })
    expect(issues).toContain("sub 'gh' sink 'phone': duplicate severity include value")
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

  it('keeps retired sink configuration in KV until finalization', () => {
    const cfg = parseRoutes(RETIRED_SINK_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    expect(plan.sinkPuts).toEqual([{
      key: 'sink:retiring',
      value: '{"topic":"retained-topic","type":"ntfy"}',
    }])
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

  it('serializes per-sink filters into runtime subscription configuration', () => {
    const cfg = parseRoutes(SINK_POLICY_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value).sinkFilters).toEqual({
      phone: {
        eventTypes: { include: ['pull_request.*'] },
        severities: { include: ['error', 'critical'] },
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
          'push.created',
          'push.updated',
          'push.deleted',
          'workflow_run.*',
          'pull_request.opened',
          'pull_request.closed',
        ],
      },
    })
  })

  it('keeps the standalone GitHub push profile unrestricted at runtime', () => {
    const cfg = parseRoutes(PUSH_ROUTES)
    const plan = computePlan(cfg, { subs: {}, sinks: {} })
    const githubPut = plan.subPuts.find((entry) => entry.key === `sub:sha256:${GITHUB_HASH}`)
    expect(JSON.parse(githubPut!.value)).not.toHaveProperty('filter')
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

  it('syncs runtime maintenance configuration without deleting fallback signals', () => {
    const cfg = parseRoutes(OPERATIONS_ROUTES)
    const fallbackKey = `ops-fallback:${'d'.repeat(64)}:record`
    const plan = computePlan(cfg, {
      subs: { [fallbackKey]: '{"version":1}' },
      sinks: {},
    })
    expect(plan.subPuts.map((entry) => entry.key)).toEqual([
      'config:operations',
      'config:retention',
      `sub:sha256:${CLAUDE_HASH}`,
      `sub:sha256:${GITHUB_HASH}`,
    ])
    expect(JSON.parse(plan.subPuts[0]!.value)).toEqual({
      alertCooldownMinutes: 60,
      sinks: ['phone'],
      staleDeliveryMinutes: 15,
    })
    expect(JSON.parse(plan.subPuts[1]!.value)).toEqual({ d1Days: 90, r2Days: 30 })
    expect(plan.subDeletes).not.toContain(fallbackKey)
  })
})

describe('printableKvKey', () => {
  it('redacts legacy raw-slug keys but leaves hashes and sink names visible', () => {
    expect(printableKvKey('sub:raw-bearer-value-aaaa')).toBe('sub:<legacy-redacted>')
    expect(printableKvKey(`sub:sha256:${CLAUDE_HASH}`)).toBe(`sub:sha256:${CLAUDE_HASH}`)
    expect(printableKvKey('sink:discord')).toBe('sink:discord')
  })
})
