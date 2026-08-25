import { describe, expect, it } from 'vitest'
import {
  EVENT_TYPE_FILTER_PATTERN_RE,
  applySubscriptionFilter,
  eventPassesFilter,
  eventTypeMatchesPattern,
  eventTypePassesFilter,
  severityPassesFilter,
} from '../../src/lib/event-filter'
import { planEventDeliveries } from '../../src/ingest'
import type { EventFilter, NormalizedEvent, SeverityFilter, Subscription } from '../../src/types'

const EVENT: NormalizedEvent = {
  source: 'github',
  subName: 'github:example-owner/example-repo',
  type: 'pull_request.opened',
  id: 'delivery-id',
  timestamp: '2026-08-15T00:00:00.000Z',
  title: 'Pull request opened',
  body: '',
  raw: {},
}

describe('event type delivery filters', () => {
  it('matches exact, namespace wildcard, and global wildcard patterns', () => {
    expect(eventTypeMatchesPattern('pull_request.opened', 'pull_request.opened')).toBe(true)
    expect(eventTypeMatchesPattern('pull_request.opened', 'pull_request.*')).toBe(true)
    expect(eventTypeMatchesPattern('pull_request.opened', '*')).toBe(true)
    expect(eventTypeMatchesPattern('pull_request.opened', 'pull_request.closed')).toBe(false)
    expect(eventTypeMatchesPattern('pull_request', 'pull_request.*')).toBe(false)
  })

  it('accepts normalized exact and trailing wildcard patterns', () => {
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('incident.resolved')).toBe(true)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('urn:cloudflare-fleet:endpoint:problem:v1')).toBe(true)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('https://events.example.com/problem')).toBe(true)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('workflow_run.*')).toBe(true)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('*')).toBe(true)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('pull_*_opened')).toBe(false)
    expect(EVENT_TYPE_FILTER_PATTERN_RE.test('PullRequest.Opened')).toBe(false)
  })

  it('requires an include match when configured and lets exclusion win', () => {
    expect(eventTypePassesFilter('pull_request.opened', {
      include: ['pull_request.*'],
      exclude: ['pull_request.synchronize'],
    })).toBe(true)
    expect(eventTypePassesFilter('pull_request.synchronize', {
      include: ['pull_request.*'],
      exclude: ['pull_request.synchronize'],
    })).toBe(false)
    expect(eventTypePassesFilter('push.updated', {
      exclude: ['pull_request.*'],
    })).toBe(true)
  })

  it('marks only nonmatching deliverable events as record-only', () => {
    const filter = { eventTypes: { include: ['pull_request.closed'] } }
    expect(applySubscriptionFilter(EVENT, filter)).toEqual({
      ...EVENT,
      shouldDeliver: false,
      deliveryDecisionReason: 'subscription-filter',
    })
    expect(applySubscriptionFilter({ ...EVENT, type: 'pull_request.closed' }, filter))
      .toEqual({ ...EVENT, type: 'pull_request.closed' })
    expect(applySubscriptionFilter({ ...EVENT, shouldDeliver: false }, {
      eventTypes: { include: ['pull_request.*'] },
    })).toEqual({
      ...EVENT,
      shouldDeliver: false,
      deliveryDecisionReason: 'source-record-only',
    })
  })

  it('filters normalized severity with info as the default', () => {
    const filter: SeverityFilter = { include: ['error', 'critical'] }
    expect(severityPassesFilter('critical', filter)).toBe(true)
    expect(severityPassesFilter('warning', filter)).toBe(false)
    expect(eventPassesFilter(EVENT, { severities: filter })).toBe(false)
    expect(eventPassesFilter({ ...EVENT, severity: 'error' }, { severities: filter })).toBe(true)
  })

  it('requires every configured filter dimension to pass', () => {
    const filter: EventFilter = {
      eventTypes: { include: ['pull_request.*'] },
      severities: { exclude: ['debug', 'info'] },
    }
    expect(eventPassesFilter({ ...EVENT, severity: 'warning' }, filter)).toBe(true)
    expect(eventPassesFilter({ ...EVENT, severity: 'info' }, filter)).toBe(false)
    expect(eventPassesFilter({ ...EVENT, type: 'push.updated', severity: 'warning' }, filter)).toBe(false)
  })

  it('plans each sink independently after the subscription filter', () => {
    const subscription: Subscription = {
      name: EVENT.subName,
      source: EVENT.source,
      enabled: true,
      sinks: ['discord', 'phone'],
      auth: null,
      filter: { eventTypes: { include: ['pull_request.*'] } },
      sinkFilters: {
        phone: { severities: { include: ['error', 'critical'] } },
      },
    }
    expect(planEventDeliveries({ ...EVENT, severity: 'warning' }, subscription)).toEqual({
      event: { ...EVENT, severity: 'warning' },
      deliveries: [
        { sinkName: 'discord', deliver: true },
        { sinkName: 'phone', deliver: false, decisionReason: 'sink-filter' },
      ],
    })
  })
})
