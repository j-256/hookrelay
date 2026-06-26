import { primaryKey, updateFanoutResults } from './persistence'
import { getSink } from './sinks'
import type { Env } from './index'
import type { FanoutResult, FanoutResults, NormalizedEvent } from './types'

interface SinkConfig {
  type: string
  [k: string]: unknown
}

async function dispatchOne(
  env: Env,
  event: NormalizedEvent,
  sinkName: string,
): Promise<FanoutResult> {
  let raw: string | null
  try {
    raw = await env.SINKS.get(`sink:${sinkName}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, errMsg: `sink KV read failed: ${msg}` }
  }
  if (!raw) return { ok: false, errMsg: `sink not found in KV: ${sinkName}` }

  let cfg: SinkConfig
  try {
    cfg = JSON.parse(raw) as SinkConfig
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, errMsg: `sink config not JSON: ${msg}` }
  }

  const sink = getSink(cfg.type)
  if (!sink) return { ok: false, errMsg: `unregistered sink type: ${cfg.type}` }

  // Strip `type` discriminator before validating; sink schemas are .strict() and don't expect it
  const { type: _type, ...sinkConfig } = cfg
  const parsed = sink.configSchema.safeParse(sinkConfig)
  if (!parsed.success) {
    return { ok: false, errMsg: `sink config invalid: ${parsed.error.message}` }
  }

  try {
    await sink.send(event, parsed.data, env)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, errMsg: msg }
  }
}

export async function fanout(
  event: NormalizedEvent,
  sinkNames: string[],
  env: Env,
): Promise<void> {
  const settled = await Promise.allSettled(
    sinkNames.map(async (name) => [name, await dispatchOne(env, event, name)] as const),
  )
  const results: FanoutResults = Object.fromEntries(
    settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : [sinkNames[i]!, { ok: false, errMsg: `dispatch threw: ${String(s.reason)}` }],
    ),
  )
  await updateFanoutResults(env, primaryKey(event), results)
}
