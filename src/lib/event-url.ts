import type { NormalizedEvent, Subscription } from '../types'

export function withSubscriptionFallbackUrl(
  event: NormalizedEvent,
  subscription: Subscription,
): NormalizedEvent {
  if (event.url || !subscription.fallbackUrl) return event
  return { ...event, url: subscription.fallbackUrl }
}
