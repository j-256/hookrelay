import { describe, expect, it } from 'vitest'
import {
  extractEmailLinkCandidates,
  normalizeEmailLinkLabel,
  selectPrimaryEmailLink,
  stripEmailUrls,
} from '../../src/lib/email-links'
import { withSubscriptionFallbackUrl } from '../../src/lib/event-url'
import { normalizeFallbackUrl } from '../../src/lib/public-url'
import type { NormalizedEvent, Subscription } from '../../src/types'

const EVENT: NormalizedEvent = {
  source: 'fixture',
  subName: 'fixture',
  type: 'fixture.event',
  id: 'event-1',
  timestamp: '2026-08-15T00:00:00.000Z',
  title: 'Fixture',
  body: 'Body',
  raw: {},
}

const SUBSCRIPTION: Subscription = {
  name: 'fixture',
  source: 'fixture',
  enabled: true,
  sinks: [],
  auth: null,
  fallbackUrl: 'https://status.example.test/',
}

describe('email link selection', () => {
  const body = [
    'View incident ( https://tracking.example.test/ls/click?upn=incident-token )',
    'Unsubscribe: https://tracking.example.test/ls/click?upn=unsubscribe-token',
  ].join('\n')

  it('extracts visible labels from common plain-text link forms', () => {
    expect(extractEmailLinkCandidates(body)).toEqual([
      { label: 'View incident', url: 'https://tracking.example.test/ls/click?upn=incident-token' },
      { label: 'Unsubscribe', url: 'https://tracking.example.test/ls/click?upn=unsubscribe-token' },
    ])
    expect(extractEmailLinkCandidates(
      '[View incident](https://tracking.example.test/ls/click?upn=markdown-token)',
    )).toEqual([{
      label: 'View incident',
      url: 'https://tracking.example.test/ls/click?upn=markdown-token',
    }])
    expect(extractEmailLinkCandidates('View incident (https://)')).toEqual([])
  })

  it('normalizes configured labels and selects one distinct matching target', () => {
    expect(normalizeEmailLinkLabel('  View   Incident ')).toBe('view incident')
    expect(selectPrimaryEmailLink(body, [' VIEW INCIDENT ']))
      .toBe('https://tracking.example.test/ls/click?upn=incident-token')
    const duplicate = `${body}\nView incident: https://tracking.example.test/ls/click?upn=incident-token`
    expect(selectPrimaryEmailLink(duplicate, ['view incident']))
      .toBe('https://tracking.example.test/ls/click?upn=incident-token')
  })

  it('fails closed for missing or ambiguous primary targets', () => {
    expect(selectPrimaryEmailLink(body, [])).toBeUndefined()
    expect(selectPrimaryEmailLink(body, ['read more'])).toBeUndefined()
    const ambiguous = `${body}\nView incident: https://tracking.example.test/ls/click?upn=second-incident-token`
    expect(selectPrimaryEmailLink(ambiguous, ['view incident'])).toBeUndefined()
  })

  it('removes every HTTP target while retaining readable labels', () => {
    const stripped = stripEmailUrls(body)
    expect(stripped).toContain('View incident')
    expect(stripped).toContain('Unsubscribe')
    expect(stripped).not.toContain('https://')
    expect(stripped).not.toContain('()')
  })

  it('rejects empty, oversized, and URL-bearing labels', () => {
    expect(() => normalizeEmailLinkLabel(' ')).toThrow(/must not be empty/)
    expect(() => normalizeEmailLinkLabel('x'.repeat(161))).toThrow(/exceeds/)
    expect(() => normalizeEmailLinkLabel('See https://example.test')).toThrow(/must not contain a URL/)
  })
})

describe('subscription fallback URLs', () => {
  it('normalizes public HTTPS URLs and rejects bearer-shaped forms', () => {
    expect(normalizeFallbackUrl(' https://STATUS.example.test/history '))
      .toBe('https://status.example.test/history')
    expect(() => normalizeFallbackUrl('http://status.example.test')).toThrow(/HTTPS/)
    expect(() => normalizeFallbackUrl('https://status.example.test/?token=opaque')).toThrow(/query/)
    expect(() => normalizeFallbackUrl('https://user:pass@status.example.test/')).toThrow(/credentials/)
    expect(() => normalizeFallbackUrl('https://status.example.test/#private')).toThrow(/fragment/)
  })

  it('uses a fallback only when the source did not provide a URL', () => {
    expect(withSubscriptionFallbackUrl(EVENT, SUBSCRIPTION).url)
      .toBe('https://status.example.test/')
    const sourceEvent = { ...EVENT, url: 'https://status.example.test/incidents/123' }
    expect(withSubscriptionFallbackUrl(sourceEvent, SUBSCRIPTION)).toBe(sourceEvent)
  })
})
