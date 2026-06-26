import type { Env } from '../index'
import type { NormalizedEvent, Subscription } from '../types'

export interface Adapter {
  readonly sourceType: string

  /**
   * Verify the request was actually sent by this source. Throws on failure.
   * MUST NOT include req.url, the slug, or any path-derived value in
   * thrown error messages -- the router logs err.message and slugs are
   * bearer tokens (spec sec 9).
   */
  verify(req: Request, raw: Uint8Array, sub: Subscription, env: Env): Promise<void>

  /**
   * Parse the (verified) body and produce a NormalizedEvent.
   * Same constraint on error messages as verify.
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
