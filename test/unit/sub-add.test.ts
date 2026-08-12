import { describe, expect, it } from 'vitest'
import { hashSubscriptionSlug } from '../../src/lib/subscription'
import {
  githubHookPayload,
  normalizeBaseUrl,
  parseSubAddArgs,
  prepareSubscription,
  selectSinks,
} from '../../scripts/sub-add'
import { parseRoutes } from '../../scripts/sync'

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

describe('parseSubAddArgs', () => {
  it('uses push as the GitHub default without parsing hyphenated names', () => {
    expect(parseSubAddArgs(['github-example-owner-example-repo', 'github', '--repo', 'example-owner/example-repo'])).toMatchObject({
      name: 'github-example-owner-example-repo',
      source: 'github',
      repo: 'example-owner/example-repo',
      githubEventMode: 'push',
    })
  })

  it('accepts recommended and manual event modes', () => {
    expect(parseSubAddArgs(['site', 'github', '--repo', 'example-owner/example-repo', '--events', 'recommended']).githubEventMode)
      .toBe('recommended')
    expect(parseSubAddArgs(['site', 'github', '--repo', 'example-owner/example-repo', '--events', 'manual']).githubEventMode)
      .toBe('manual')
  })

  it('keeps GitHub-only options off other sources', () => {
    expect(() => parseSubAddArgs(['claude', 'statuspage', '--events', 'push'])).toThrow(/only valid for GitHub/)
    expect(() => parseSubAddArgs(['site', 'github'])).toThrow(/require --repo/)
  })
})

describe('subscription preparation', () => {
  it('writes hash-only config, local sender auth, and a reusable base URL', async () => {
    const options = parseSubAddArgs([
      'github-example-owner-example-repo',
      'github',
      '--repo',
      'example-owner/example-repo',
      '--events',
      'recommended',
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
      name: 'github-example-owner-example-repo',
      source: 'github',
      slugHash: await hashSubscriptionSlug(RAW_SLUG),
      enabled: true,
      sinks: ['discord'],
      auth: { scheme: 'github-sha256', secretEnv: 'HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO' },
    })
    expect(prepared.devVarsText).toContain(`HMAC_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO=${HMAC_SECRET}\n`)
    expect(prepared.webhookUrl).toBe(`https://hooks.example.com/hook/github/${RAW_SLUG}`)
    expect(prepared.slugSecretName).toBe('SUB_GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO_SLUG')
  })

  it('requires explicit sink selection when more than one is configured', () => {
    expect(() => selectSinks(['discord', 'phone'], [])).toThrow(/multiple sinks/)
    expect(selectSinks(['discord', 'phone'], ['phone', 'discord'])).toEqual(['phone', 'discord'])
  })

  it('normalizes host-only HTTPS base URLs', () => {
    expect(normalizeBaseUrl('https://hooks.example.com/')).toBe('https://hooks.example.com')
    expect(() => normalizeBaseUrl('http://hooks.example.com')).toThrow(/https/)
    expect(() => normalizeBaseUrl('https://hooks.example.com/path')).toThrow(/scheme and host/)
  })
})

describe('GitHub hook payload', () => {
  it('uses JSON, HMAC, SSL verification, and the selected event mode', () => {
    expect(githubHookPayload('https://hooks.example.com/hook/github/slug', HMAC_SECRET, 'push')).toEqual({
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: 'https://hooks.example.com/hook/github/slug',
        content_type: 'json',
        secret: HMAC_SECRET,
        insecure_ssl: '0',
      },
    })
    expect(githubHookPayload('https://hooks.example.com/hook/github/slug', HMAC_SECRET, 'all'))
      .toMatchObject({ events: ['*'] })
    expect(githubHookPayload('https://hooks.example.com/hook/github/slug', HMAC_SECRET, 'manual')).toBeNull()
  })
})
