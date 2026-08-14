import { prepareDeliveries } from './delivery'
import type { Env } from './index'
import { persistEvent, primaryKey } from './persistence'
import type { NormalizedEvent } from './types'

export interface IngestResult {
  eventId: string
  duplicate: boolean
}

export async function ingestEvent(
  env: Env,
  event: NormalizedEvent,
  rawBody: Uint8Array,
  contentType: string,
  subscriptionHash: string,
  sinkNames: string[],
): Promise<IngestResult> {
  const persisted = await persistEvent(
    env,
    event,
    rawBody,
    contentType,
    subscriptionHash,
  )
  const eventId = primaryKey(event)
  const deliverySinks = event.shouldDeliver === false ? [] : sinkNames
  const enqueue = await prepareDeliveries(env, eventId, deliverySinks)

  if (enqueue.deferred > 0) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'event.delivery.deferred',
      eventId,
      source: event.source,
      subName: event.subName,
      count: enqueue.deferred,
    }))
  }

  if (persisted.duplicate) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'event.duplicate',
      eventId,
      source: event.source,
      subName: event.subName,
      type: event.type,
    }))
    return { eventId, duplicate: true }
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'event.accepted',
    eventId,
    source: event.source,
    subName: event.subName,
    type: event.type,
    severity: event.severity ?? null,
    sinks: deliverySinks,
  }))
  return { eventId, duplicate: false }
}
