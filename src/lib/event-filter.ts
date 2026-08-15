import type { EventTypeFilter, NormalizedEvent, SubscriptionFilter } from '../types'

const EVENT_TYPE_SEGMENT_PATTERN = '[a-z0-9_-]+'
export const EVENT_TYPE_FILTER_PATTERN_RE = new RegExp(
  `^(?:\\*|${EVENT_TYPE_SEGMENT_PATTERN}(?:\\.${EVENT_TYPE_SEGMENT_PATTERN})*(?:\\.\\*)?)$`,
)

export function eventTypeMatchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -1))
  return eventType === pattern
}

export function eventTypePassesFilter(eventType: string, filter: EventTypeFilter): boolean {
  const included = filter.include === undefined
    || filter.include.some((pattern) => eventTypeMatchesPattern(eventType, pattern))
  const excluded = filter.exclude?.some((pattern) => eventTypeMatchesPattern(eventType, pattern)) ?? false
  return included && !excluded
}

export function applySubscriptionFilter(
  event: NormalizedEvent,
  filter: SubscriptionFilter | undefined,
): NormalizedEvent {
  if (event.shouldDeliver === false || filter === undefined) return event
  if (eventTypePassesFilter(event.type, filter.eventTypes)) return event
  return { ...event, shouldDeliver: false }
}
