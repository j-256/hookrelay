import type {
  DeliveryDecisionReason,
  EventFilter,
  EventTypeFilter,
  NormalizedEvent,
  Severity,
  SeverityFilter,
  SubscriptionFilter,
} from '../types'

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

export function severityPassesFilter(severity: Severity, filter: SeverityFilter): boolean {
  const included = filter.include === undefined || filter.include.includes(severity)
  const excluded = filter.exclude?.includes(severity) ?? false
  return included && !excluded
}

export function eventPassesFilter(event: NormalizedEvent, filter: EventFilter): boolean {
  if (filter.eventTypes && !eventTypePassesFilter(event.type, filter.eventTypes)) return false
  if (filter.severities && !severityPassesFilter(event.severity ?? 'info', filter.severities)) {
    return false
  }
  return true
}

function recordOnly(
  event: NormalizedEvent,
  reason: DeliveryDecisionReason,
): NormalizedEvent {
  return { ...event, shouldDeliver: false, deliveryDecisionReason: reason }
}

export function applySubscriptionFilter(
  event: NormalizedEvent,
  filter: SubscriptionFilter | undefined,
): NormalizedEvent {
  if (event.shouldDeliver === false) {
    return event.deliveryDecisionReason
      ? event
      : recordOnly(event, 'source-record-only')
  }
  if (filter === undefined || eventPassesFilter(event, filter)) return event
  return recordOnly(event, 'subscription-filter')
}
