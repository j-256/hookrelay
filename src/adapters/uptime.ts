import type { Adapter } from '.'
import { hmacSha256Hex } from '../lib/hmac'
import type { NormalizedEvent, Severity, Subscription } from '../types'

const TYPE_MAP: Record<string, { type: string; severity: Severity }> = {
  '1': { type: 'monitor.down', severity: 'error' },
  '2': { type: 'monitor.up', severity: 'info' },
  '3': { type: 'monitor.ssl', severity: 'warning' },
}

interface UptimePayload {
  monitorID?: string
  monitorURL?: string
  monitorFriendlyName?: string
  alertType?: string
  alertTypeFriendlyName?: string
  alertDetails?: string
  alertDuration?: string
  alertDateTime?: string
}

const adapter: Adapter = {
  sourceType: 'uptime',

  async verify(_req, _raw, _sub, _env) {
    /* no sender-side auth */
  },

  async parse(_req: Request, raw: Uint8Array, sub: Subscription): Promise<NormalizedEvent> {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as UptimePayload

    if (!payload.alertDateTime) {
      throw new Error(
        'uptime payload missing alertDateTime; configure your UptimeRobot webhook template to include *alertDateTime*',
      )
    }

    const mapping = TYPE_MAP[payload.alertType ?? ''] ?? { type: 'monitor.event', severity: 'info' as Severity }

    const id = (await hmacSha256Hex('hookrelay-uptime-id', raw)).slice(0, 32)
    const tsMs = Number(payload.alertDateTime) * 1000
    const timestamp = Number.isFinite(tsMs) ? new Date(tsMs).toISOString() : new Date().toISOString()
    const friendlyName = payload.monitorFriendlyName ?? payload.monitorURL ?? '(monitor)'

    return {
      source: 'uptime',
      subName: sub.name,
      type: mapping.type,
      id,
      timestamp,
      title: `${friendlyName} ${payload.alertTypeFriendlyName ?? mapping.type}`,
      body: payload.alertDetails ?? '',
      url: payload.monitorURL,
      severity: mapping.severity,
      raw: payload,
    }
  },
}

export default adapter
