import type { Env } from '../../src/index'
import type { DeliveryMessage } from '../../src/types'

export interface RecordingQueue {
  binding: Queue<DeliveryMessage>
  messages: DeliveryMessage[]
}

export function recordingQueue(error?: Error): RecordingQueue {
  const messages: DeliveryMessage[] = []
  const sendBatch = async (requests: Iterable<MessageSendRequest<DeliveryMessage>>) => {
    if (error) throw error
    for (const request of requests) messages.push(request.body)
    return {
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
    }
  }
  return {
    binding: { sendBatch } as unknown as Queue<DeliveryMessage>,
    messages,
  }
}

export function withDeliveryQueue(baseEnv: Env, queue: Queue<DeliveryMessage>): Env {
  return new Proxy(baseEnv, {
    get(target, property, receiver) {
      if (property === 'DELIVERY_QUEUE') return queue
      return Reflect.get(target, property, receiver)
    },
  })
}
