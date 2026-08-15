import type { Env } from '../index'
import type { NormalizedEvent, Subscription } from '../types'

export interface Adapter {
  readonly sourceType: string

  /**
   * Verify the request was actually sent by this source and throw on failure
   * Keep thrown errors free of req.url, the slug, and path-derived values
   */
  verify(req: Request, raw: Uint8Array, sub: Subscription, env: Env): Promise<void>

  /**
   * Parse the verified body and produce a NormalizedEvent
   * Keep thrown errors within the same boundary as verify
   */
  parse(req: Request, raw: Uint8Array, sub: Subscription): Promise<NormalizedEvent>
}

const registry = new Map<string, Adapter>()

export function registerAdapter(adapter: Adapter): void {
  if (registry.has(adapter.sourceType)) {
    throw new Error(`adapter already registered: ${adapter.sourceType}`)
  }
  registry.set(adapter.sourceType, adapter)
}

export function getAdapter(sourceType: string): Adapter | null {
  return registry.get(sourceType) ?? null
}

export function listSourceTypes(): string[] {
  return [...registry.keys()].sort()
}
