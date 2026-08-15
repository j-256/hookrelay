import { prepareDeliveries } from './delivery'
import type { Env } from './index'
import { applySubscriptionFilter, eventPassesFilter } from './lib/event-filter'
import { persistEvent, primaryKey } from './persistence'
import type { DeliveryPlan, NormalizedEvent, Subscription } from './types'

export interface IngestResult {
  eventId: string
  duplicate: boolean
}

export interface PlannedEvent {
  event: NormalizedEvent
  deliveries: DeliveryPlan[]
}

export function planEventDeliveries(
  event: NormalizedEvent,
  subscription: Subscription,
): PlannedEvent {
  const filteredEvent = applySubscriptionFilter(event, subscription.filter)
  const deliveries = subscription.sinks.map((sinkName): DeliveryPlan => {
    if (filteredEvent.shouldDeliver === false) {
      return {
        sinkName,
        deliver: false,
        decisionReason: filteredEvent.deliveryDecisionReason ?? 'source-record-only',
      }
    }
    const sinkFilter = subscription.sinkFilters?.[sinkName]
    if (sinkFilter && !eventPassesFilter(filteredEvent, sinkFilter)) {
      return { sinkName, deliver: false, decisionReason: 'sink-filter' }
    }
    return { sinkName, deliver: true }
  })
  return { event: filteredEvent, deliveries }
}

export async function ingestEvent(
  env: Env,
  event: NormalizedEvent,
  rawBody: Uint8Array,
  contentType: string,
  subscriptionHash: string,
  subscription: Subscription,
): Promise<IngestResult> {
  const planned = planEventDeliveries(event, subscription)
  const persisted = await persistEvent(
    env,
    planned.event,
    rawBody,
    contentType,
    subscriptionHash,
  )
  const eventId = primaryKey(planned.event)
  const enqueue = await prepareDeliveries(env, eventId, planned.deliveries)

  if (enqueue.deferred > 0) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'event.delivery.deferred',
      eventId,
      source: planned.event.source,
      subName: planned.event.subName,
      count: enqueue.deferred,
    }))
  }

  if (persisted.duplicate) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'event.duplicate',
      eventId,
      source: planned.event.source,
      subName: planned.event.subName,
      type: planned.event.type,
    }))
    return { eventId, duplicate: true }
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'event.accepted',
    eventId,
    source: planned.event.source,
    subName: planned.event.subName,
    type: planned.event.type,
    severity: planned.event.severity ?? null,
    sinks: planned.deliveries.filter((delivery) => delivery.deliver).map((delivery) => delivery.sinkName),
    filteredSinks: planned.deliveries.filter((delivery) => !delivery.deliver).map((delivery) => delivery.sinkName),
  }))
  return { eventId, duplicate: false }
}
