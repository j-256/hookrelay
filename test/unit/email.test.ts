import { describe, expect, it } from 'vitest'
import {
  htmlToPlainText,
  normalizeEmail,
  normalizeSenderRule,
  parseEmailRoute,
  redactEmailRoute,
  senderMatchesRule,
  type IncomingEmailMessage,
} from '../../src/email'
import {
  normalizeEmailRouteSlug,
  routedEmailAddress,
} from '../../src/lib/email-address'
import { hashSubscriptionSlug } from '../../src/lib/subscription'
import type { Subscription } from '../../src/types'
import HTML_EMAIL from '../fixtures/email/html-only.eml?raw'
import PLAIN_EMAIL from '../fixtures/email/plain.eml?raw'

const RAW_SLUG = 'a7f3b2c8d9e1f4g6h8j0k2'

function incoming(raw: string, overrides: Partial<IncomingEmailMessage> = {}): IncomingEmailMessage {
  return {
    from: 'notifications@status.openai.com',
    to: `relay+${RAW_SLUG}@mail.example.com`,
    headers: new Headers(),
    raw: new Blob([raw]).stream(),
    rawSize: new TextEncoder().encode(raw).byteLength,
    setReject: () => {},
    ...overrides,
  }
}

function subscription(allowedSenders: string[] = []): Subscription {
  return {
    name: 'openai-status',
    source: 'email',
    enabled: true,
    sinks: ['discord'],
    auth: null,
    email: { allowedSenders },
  }
}

describe('parseEmailRoute', () => {
  it('normalizes plus route token case', () => {
    expect(parseEmailRoute(`relay+${RAW_SLUG}@mail.example.com`)).toEqual({ slug: RAW_SLUG })
    expect(parseEmailRoute(`relay+${RAW_SLUG.toUpperCase()}@mail.example.com`)).toEqual({
      slug: RAW_SLUG,
    })
    expect(normalizeEmailRouteSlug(RAW_SLUG.toUpperCase())).toBe(RAW_SLUG)
    expect(routedEmailAddress('relay@mail.example.com', RAW_SLUG.toUpperCase()))
      .toBe(`relay+${RAW_SLUG}@mail.example.com`)
  })

  it('rejects base addresses and malformed route tokens', () => {
    expect(parseEmailRoute('relay@mail.example.com')).toBeNull()
    expect(parseEmailRoute('relay+short@mail.example.com')).toBeNull()
    expect(parseEmailRoute(`+${RAW_SLUG}@mail.example.com`)).toBeNull()
  })

  it('redacts route tokens while preserving the routing context', () => {
    expect(redactEmailRoute(`relay+${RAW_SLUG}@mail.example.com`))
      .toBe('relay+<redacted>@mail.example.com')
    expect(redactEmailRoute('relay@mail.example.com')).toBe('relay@mail.example.com')
  })
})

describe('sender rules', () => {
  it('normalizes and matches exact mailboxes and domains', () => {
    expect(normalizeSenderRule(' Notifications@Status.OpenAI.com ')).toBe('notifications@status.openai.com')
    expect(normalizeSenderRule(' @Status.OpenAI.com ')).toBe('@status.openai.com')
    expect(senderMatchesRule('alerts@status.openai.com', '@status.openai.com')).toBe(true)
    expect(senderMatchesRule('status.openai.com@example.net', '@status.openai.com')).toBe(false)
    expect(senderMatchesRule('alerts@example.net', 'alerts@example.net')).toBe(true)
  })

  it('rejects malformed rules', () => {
    expect(() => normalizeSenderRule('example.net')).toThrow(/invalid sender/)
    expect(() => normalizeSenderRule('@-example.net')).toThrow(/invalid sender/)
  })
})

describe('htmlToPlainText', () => {
  it('keeps readable text and links without executable or styled content', () => {
    const result = htmlToPlainText(`
      <style>secret style</style>
      <script>alert('no')</script>
      <p>Service &amp; API</p>
      <a href="https://status.example.net/i/1">View status</a>
    `)
    expect(result).toContain('Service & API')
    expect(result).toContain('View status (https://status.example.net/i/1)')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('secret style')
  })
})

describe('normalizeEmail', () => {
  it('prefers plain text and produces a deterministic normalized event', async () => {
    const raw = new TextEncoder().encode(PLAIN_EMAIL)
    const subHash = await hashSubscriptionSlug(RAW_SLUG)
    const event = await normalizeEmail(
      raw,
      incoming(PLAIN_EMAIL),
      subscription(['@status.openai.com']),
      subHash,
      new Date('2026-08-14T00:00:00.000Z'),
    )

    expect(event).toMatchObject({
      source: 'email',
      subName: 'openai-status',
      type: 'email.received',
      timestamp: '2026-08-13T18:42:00.000Z',
      title: 'Elevated errors for ChatGPT',
      severity: 'info',
      url: 'https://status.openai.com/incidents/example',
    })
    expect(event.id).toMatch(new RegExp(`^${subHash}:[a-f0-9]{64}$`))
    expect(event.body).toContain('We are investigating elevated errors')
    expect(event.body).not.toContain('HTML fallback should not replace')
    expect(event.raw).toMatchObject({
      envelope: {
        from: 'notifications@status.openai.com',
        to: 'relay+<redacted>@mail.example.com',
      },
      headers: {
        from: ['notifications@status.openai.com'],
        to: ['relay+<redacted>@mail.example.com'],
        messageId: '<incident-123-update-1@status.openai.com>',
      },
      attachments: [{
        filename: 'details.txt',
        mimeType: 'text/plain',
        disposition: 'attachment',
      }],
    })
  })

  it('converts an HTML-only message to plain text', async () => {
    const raw = new TextEncoder().encode(HTML_EMAIL)
    const event = await normalizeEmail(
      raw,
      incoming(HTML_EMAIL, { from: 'robot@example.net' }),
      subscription(['robot@example.net']),
      await hashSubscriptionSlug(RAW_SLUG),
    )

    expect(event.body).toContain('Resolved')
    expect(event.body).toContain('All systems are operational & traffic is healthy.')
    expect(event.body).toContain('View incident (https://status.example.net/incidents/456)')
    expect(event.body).not.toContain('<html>')
  })

  it('requires both envelope and header senders to match an allowlist', async () => {
    const raw = new TextEncoder().encode(PLAIN_EMAIL)
    await expect(normalizeEmail(
      raw,
      incoming(PLAIN_EMAIL, { from: 'forwarder@example.net' }),
      subscription(['@status.openai.com']),
      await hashSubscriptionSlug(RAW_SLUG),
    )).rejects.toMatchObject({ reason: 'Sender not allowed' })

    await expect(normalizeEmail(
      raw,
      incoming(PLAIN_EMAIL),
      subscription(['forwarder@example.net']),
      await hashSubscriptionSlug(RAW_SLUG),
    )).rejects.toMatchObject({ reason: 'Sender not allowed' })
  })
})
