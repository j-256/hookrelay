import { describe, expect, it } from 'vitest'
import {
  EVENT_TYPE_FILTER_PATTERN_RE,
  applySubscriptionFilter,
  eventTypeMatchesPattern,
  eventTypePassesFilter,
} from '../../src/lib/event-filter'
import type { NormalizedEvent } from '../../src/types'

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
    expect(applySubscriptionFilter(EVENT, filter)).toEqual({ ...EVENT, shouldDeliver: false })
    expect(applySubscriptionFilter({ ...EVENT, type: 'pull_request.closed' }, filter))
      .toEqual({ ...EVENT, type: 'pull_request.closed' })
    expect(applySubscriptionFilter({ ...EVENT, shouldDeliver: false }, {
      eventTypes: { include: ['pull_request.*'] },
    })).toEqual({ ...EVENT, shouldDeliver: false })
  })
})
