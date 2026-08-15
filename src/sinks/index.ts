import type { z } from 'zod'
import type { Env } from '../index'
import type { NormalizedEvent, SinkDeliveryContext } from '../types'

export interface Sink<TConfig = unknown> {
  readonly type: string
  readonly configSchema: z.ZodType<TConfig>
  send(
    event: NormalizedEvent,
    config: TConfig,
    env: Env,
    context: SinkDeliveryContext,
    fetchFn?: typeof fetch,
  ): Promise<void>
}

const registry = new Map<string, Sink<unknown>>()

export function registerSink<T>(sink: Sink<T>): void {
  if (registry.has(sink.type)) {
    throw new Error(`sink already registered: ${sink.type}`)
  }
  registry.set(sink.type, sink as Sink<unknown>)
}

export function getSink(type: string): Sink<unknown> | null {
  return registry.get(type) ?? null
}

export function listSinkTypes(): string[] {
  return [...registry.keys()].sort()
}
