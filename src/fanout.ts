import { resolveDestination } from './lib/destination-custody'
import { getSink } from './sinks'
import { readRuntimeConfiguration } from './configuration/authority'
import type { Env } from './index'
import { HttpError } from './lib/http'
import type { NormalizedEvent, SinkDeliveryContext } from './types'

interface SinkConfig {
  type: string
  [k: string]: unknown
}

export interface DispatchResult {
  ok: boolean
  errMsg?: string
  retryAfterSeconds?: number
}

export async function dispatchSink(
  env: Env,
  event: NormalizedEvent,
  sinkName: string,
  context: SinkDeliveryContext = {
    eventId: `${event.source}:${event.id}`,
    sinkName,
    generation: 0,
    attempt: 1,
  },
): Promise<DispatchResult> {
  let raw: string | null
  try {
    raw = await readRuntimeConfiguration(env, 'SINKS', `sink:${sinkName}`)
  } catch {
    return { ok: false, errMsg: 'sink configuration is unavailable' }
  }
  if (!raw) return { ok: false, errMsg: `sink configuration not found: ${sinkName}` }

  let cfg: SinkConfig
  try {
    cfg = JSON.parse(raw) as SinkConfig
  } catch {
    return { ok: false, errMsg: 'sink configuration is not valid JSON' }
  }

  const sink = getSink(cfg.type)
  if (!sink) return { ok: false, errMsg: `unregistered sink type: ${cfg.type}` }

  // Strip `type` discriminator before validating; sink schemas are .strict() and don't expect it
  let deliveryEnv = env
  let sinkConfig: Record<string, unknown>
  try {
    if (cfg.custody) {
      const resolved = await resolveDestination(env, cfg.type, cfg.custody)
      sinkConfig = resolved.config
      deliveryEnv = new Proxy(env, { get(target, name, receiver) {
        return typeof name === 'string' && name in resolved.secrets ? resolved.secrets[name] : Reflect.get(target, name, receiver)
      } })
    } else {
      const { type: _type, ...config } = cfg
      sinkConfig = config
    }
  } catch { return { ok: false, errMsg: 'destination custody is unavailable' } }
  const parsed = sink.configSchema.safeParse(sinkConfig)
  if (!parsed.success) {
    return { ok: false, errMsg: `sink config invalid: ${parsed.error.message}` }
  }

  try {
    await sink.send(event, parsed.data, deliveryEnv, context)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      errMsg: cfg.custody ? 'destination delivery failed' : msg,
      retryAfterSeconds: err instanceof HttpError ? err.retryAfterSeconds : undefined,
    }
  }
}
