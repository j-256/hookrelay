import { describe, expect, it, vi } from 'vitest'
import { parseGitHubEventSelection } from '../../scripts/github-events'
import { githubHookPayload } from '../../scripts/github-repository'
import {
  normalizeBaseUrl,
  parseSubAddArgs,
  prepareSubscription,
  resolveSubscriptionBaseUrl,
  resolveSubscriptionEmailBaseAddress,
  selectSinks,
} from '../../scripts/sub-add'
import { parseRoutes } from '../../scripts/sync'
import { hashSubscriptionSlug } from '../../src/lib/subscription'

const RAW_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2'
const HMAC_SECRET = 'hmac-secret-for-tests'
const ROUTES = `
// Keep this comment
{
  "subs": [],
  "sinks": [
    { "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" }
  ]
}
`

function routesWithLocalSettings(settings: { baseUrl?: string; emailBaseAddress?: string }): string {
  return JSON.stringify({ ...parseRoutes(ROUTES), ...settings })
}

describe('parseSubAddArgs', () => {
  it('uses push as the GitHub default without parsing the subscription name', () => {
    const options = parseSubAddArgs(['github:example-owner/example-repo', 'github', '--repo', 'example-owner/example-repo'])
    expect(options).toMatchObject({
      name: 'github:example-owner/example-repo',
      source: 'github',
      repo: 'example-owner/example-repo',
    })
    expect(options.githubEvents).toEqual({ kind: 'events', names: ['push'], events: ['push'] })
  })

  it('accepts composable, recommended, and manual event selections', () => {
    expect(parseSubAddArgs([
      'site', 'github', '--repo', 'example-owner/example-repo', '--events', 'stars,watchers',
    ]).githubEvents.events).toEqual(['star', 'watch'])
    expect(parseSubAddArgs([
      'site', 'github', '--repo', 'example-owner/example-repo', '--events', 'recommended',
    ]).githubEvents.names).toEqual(['recommended'])
    expect(parseSubAddArgs([
      'site', 'github', '--repo', 'example-owner/example-repo', '--events', 'manual',
    ]).githubEvents.kind).toBe('manual')
  })

  it('accepts short option aliases', () => {
    const options = parseSubAddArgs([
      'site',
      'github',
      '-s',
      'discord',
      '-b',
      'https://hooks.example.com',
      '-r',
      'example-owner/example-repo',
      '-e',
      'stars,watchers',
      '-y',
    ])
    expect(options).toMatchObject({
      sinks: ['discord'],
      baseUrl: 'https://hooks.example.com',
      repo: 'example-owner/example-repo',
      yes: true,
    })
    expect(options.githubEvents.names).toEqual(['stars', 'watchers'])
  })

  it('rejects unknown short options', () => {
    expect(() => parseSubAddArgs(['claude', 'statuspage', '-x'])).toThrow(/unknown option: -x/)
  })

  it('keeps GitHub-only options off other sources', () => {
    expect(() => parseSubAddArgs(['claude', 'statuspage', '--events', 'push'])).toThrow(/only valid for GitHub/)
    expect(() => parseSubAddArgs(['site', 'github'])).toThrow(/require --repo/)
  })

  it('accepts repeatable sender rules for email subscriptions', () => {
    const options = parseSubAddArgs([
      'openai-status',
      'email',
      '--email-base',
      'Relay@Mail.Example.com',
      '--allow-sender',
      '@Status.OpenAI.com',
      '--allow-sender',
      'notifications@example.net',
      '--primary-link-label',
      'View Incident',
      '--fallback-url',
      'https://status.openai.com',
    ])
    expect(options).toMatchObject({
      source: 'email',
      emailBaseAddress: 'Relay@Mail.Example.com',
      allowedSenders: ['@status.openai.com', 'notifications@example.net'],
      primaryLinkLabels: ['view incident'],
      fallbackUrl: 'https://status.openai.com/',
    })
  })

  it('keeps transport-specific options on their matching source', () => {
    expect(() => parseSubAddArgs([
      'openai-status', 'email', '--base-url', 'https://hooks.example.com',
    ])).toThrow(/not valid for email/)
    expect(() => parseSubAddArgs([
      'claude', 'statuspage', '--email-base', 'relay@mail.example.com',
    ])).toThrow(/only valid for email/)
    expect(() => parseSubAddArgs([
      'claude', 'statuspage', '--allow-sender', '@example.com',
    ])).toThrow(/only valid for email/)
    expect(() => parseSubAddArgs([
      'claude', 'statuspage', '--primary-link-label', 'View incident',
    ])).toThrow(/only valid for email/)
    expect(() => parseSubAddArgs([
      'service', 'email', '--allow-sender', '@example.com', '--allow-sender', '@EXAMPLE.COM',
    ])).toThrow(/rule supplied more than once/)
    expect(() => parseSubAddArgs([
      'service', 'email', '--primary-link-label', 'View Incident', '--primary-link-label', 'view incident',
    ])).toThrow(/link label supplied more than once/)
  })
})

describe('subscription preparation', () => {
  it('writes hash-only config, local sender auth, provider setup, and a reusable base URL', async () => {
    const options = parseSubAddArgs([
      'github:example-owner/example-repo',
      'github',
      '--repo',
      'example-owner/example-repo',
      '--events',
      'stars,watchers',
      '--base-url',
      'https://hooks.example.com',
    ])
    const prepared = await prepareSubscription(ROUTES, 'CF_ACCESS_AUD=test\n', options, {
      slug: RAW_SLUG,
      senderSecret: HMAC_SECRET,
    })
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).toContain('// Keep this comment')
    expect(prepared.routesText).not.toContain(RAW_SLUG)
    expect(routes.baseUrl).toBe('https://hooks.example.com')
    expect(routes.subs[0]).toEqual({
      name: 'github:example-owner/example-repo',
      source: 'github',
      slugHash: await hashSubscriptionSlug(RAW_SLUG),
      enabled: true,
      sinks: ['discord'],
      auth: { scheme: 'github-sha256', secretEnv: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO' },
      setup: {
        github: {
          repo: 'example-owner/example-repo',
          eventProfiles: ['stars', 'watchers'],
        },
      },
    })
    expect(prepared.devVarsText).toContain(`HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO=${HMAC_SECRET}\n`)
    expect(prepared.webhookUrl).toBe(`https://hooks.example.com/hook/github/${RAW_SLUG}`)
    expect(prepared.slugSecretName).toBe('SUB_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_SLUG')
  })

  it('requires explicit sink selection when more than one is configured', () => {
    expect(() => selectSinks(['discord', 'phone'], [])).toThrow(/multiple sinks/)
    expect(selectSinks(['discord', 'phone'], ['phone', 'discord'])).toEqual(['phone', 'discord'])
  })

  it('writes a generic email route and prints an address without an HTTP endpoint', async () => {
    const options = parseSubAddArgs([
      'openai-status',
      'email',
      '--email-base',
      'relay@mail.example.com',
      '--allow-sender',
      '@status.openai.com',
      '--primary-link-label',
      'View incident',
      '--fallback-url',
      'https://status.openai.com',
    ])
    const prepared = await prepareSubscription(ROUTES, 'CF_ACCESS_AUD=test\n', options, {
      slug: RAW_SLUG.toUpperCase(),
    })
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).not.toContain(RAW_SLUG)
    expect(routes.emailBaseAddress).toBe('relay@mail.example.com')
    expect(routes.subs[0]).toEqual({
      name: 'openai-status',
      source: 'email',
      slugHash: await hashSubscriptionSlug(RAW_SLUG),
      enabled: true,
      sinks: ['discord'],
      auth: null,
      fallbackUrl: 'https://status.openai.com/',
      email: {
        allowedSenders: ['@status.openai.com'],
        primaryLinkLabels: ['view incident'],
      },
    })
    expect(prepared.emailAddress).toBe(`relay+${RAW_SLUG}@mail.example.com`)
    expect(prepared.webhookUrl).toBeUndefined()
    expect(prepared.senderSecret).toBeNull()
    expect(prepared.devVarsText).toBe('CF_ACCESS_AUD=test\n')
  })

  it('generates lowercase hexadecimal routes for email providers', async () => {
    const options = parseSubAddArgs([
      'openai-status',
      'email',
      '--email-base',
      'relay@mail.example.com',
    ])
    const prepared = await prepareSubscription(ROUTES, '', options)

    expect(prepared.rawSlug).toMatch(/^[a-f0-9]{32}$/)
    expect(prepared.emailAddress).toBe(`relay+${prepared.rawSlug}@mail.example.com`)
    expect(parseRoutes(prepared.routesText).subs[0]?.slugHash)
      .toBe(await hashSubscriptionSlug(prepared.rawSlug))
  })

  it('writes a source-independent fallback URL', async () => {
    const options = parseSubAddArgs([
      'claude-status',
      'statuspage',
      '--base-url',
      'https://hooks.example.com',
      '--fallback-url',
      'https://status.claude.com',
    ])
    const prepared = await prepareSubscription(ROUTES, '', options, { slug: RAW_SLUG })

    expect(parseRoutes(prepared.routesText).subs[0]?.fallbackUrl)
      .toBe('https://status.claude.com/')
  })
})

describe('base URL resolution', () => {
  it('normalizes host-only HTTPS base URLs', () => {
    expect(normalizeBaseUrl('https://hooks.example.com/')).toBe('https://hooks.example.com')
    expect(() => normalizeBaseUrl('http://hooks.example.com')).toThrow(/https/)
    expect(() => normalizeBaseUrl('https://hooks.example.com/path')).toThrow(/scheme and host/)
  })

  it('prefers an explicit URL, then saved local config, then discovery', async () => {
    const discover = vi.fn(async () => 'https://discovered.example.com')
    const saved = routesWithLocalSettings({ baseUrl: 'https://saved.example.com' })

    await expect(resolveSubscriptionBaseUrl(saved, 'https://explicit.example.com', discover))
      .resolves.toBe('https://explicit.example.com')
    await expect(resolveSubscriptionBaseUrl(saved, undefined, discover))
      .resolves.toBe('https://saved.example.com')
    await expect(resolveSubscriptionBaseUrl(ROUTES, undefined, discover))
      .resolves.toBe('https://discovered.example.com')
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it('uses an explicit or saved email base address without discovery', () => {
    const saved = routesWithLocalSettings({ emailBaseAddress: 'saved@mail.example.com' })
    expect(resolveSubscriptionEmailBaseAddress(saved, 'EXPLICIT@MAIL.EXAMPLE.COM'))
      .toBe('explicit@mail.example.com')
    expect(resolveSubscriptionEmailBaseAddress(saved, undefined)).toBe('saved@mail.example.com')
    expect(() => resolveSubscriptionEmailBaseAddress(ROUTES, undefined)).toThrow(/--email-base/)
    expect(() => resolveSubscriptionEmailBaseAddress(ROUTES, 'relay+tag@mail.example.com'))
      .toThrow(/must not contain plus/)
  })
})

describe('GitHub hook payload', () => {
  it('uses JSON, HMAC, SSL verification, and expanded event profiles', () => {
    expect(githubHookPayload(
      'https://hooks.example.com/hook/github/slug',
      HMAC_SECRET,
      parseGitHubEventSelection('stars,watchers'),
    )).toEqual({
      name: 'web',
      active: true,
      events: ['star', 'watch'],
      config: {
        url: 'https://hooks.example.com/hook/github/slug',
        content_type: 'json',
        secret: HMAC_SECRET,
        insecure_ssl: '0',
      },
    })
    expect(githubHookPayload(
      'https://hooks.example.com/hook/github/slug',
      HMAC_SECRET,
      parseGitHubEventSelection('all'),
    )).toMatchObject({ events: ['*'] })
    expect(githubHookPayload(
      'https://hooks.example.com/hook/github/slug',
      HMAC_SECRET,
      parseGitHubEventSelection('manual'),
    )).toBeNull()
  })
})
