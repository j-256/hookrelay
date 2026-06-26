import type { Adapter } from '.'
import { hmacSha256Hex, timingSafeEqualString } from '../lib/hmac'
import type { Env } from '../index'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, Severity, Subscription } from '../types'

interface CfPayload {
  name?: string
  text?: string
  data?: unknown
  ts?: number
  account_id?: string
  policy_id?: string
  policy_name?: string
  alert_type?: string
  alert_correlation_id?: string
  alert_event?: string
}

function severityFor(p: CfPayload): Severity {
  if (p.alert_event === 'ALERT_STATE_EVENT_END') return 'info'
  // CF doesn't ship a single severity field; default to warning for active alerts and let the user re-tune later
  return 'warning'
}

async function contentId(p: CfPayload): Promise<string> {
  const tuple = JSON.stringify([
    p.account_id ?? '',
    p.policy_id ?? '',
    p.alert_correlation_id ?? '',
    p.alert_event ?? '',
    p.alert_type ?? '',
    p.ts ?? 0,
  ])
  // hmacSha256Hex with a fixed pseudo-key is fine for non-security hashing; gives stable hex output
  return (await hmacSha256Hex('hookrelay-cf-id', new TextEncoder().encode(tuple))).slice(0, 32)
}

const adapter: Adapter = {
  sourceType: 'cloudflare-notifications',

  async verify(req: Request, _raw: Uint8Array, sub: Subscription, env: Env): Promise<void> {
    if (!sub.auth) throw new Error('cloudflare adapter requires sub.auth')
    const header = req.headers.get('cf-webhook-auth')
    if (!header) throw new Error('missing cf-webhook-auth header')
    const expected = readSecret(env, sub.auth.secretEnv)
    if (!timingSafeEqualString(expected, header)) {
      throw new Error('cf-webhook-auth mismatch')
    }
  },

  async parse(_req: Request, raw: Uint8Array, sub: Subscription): Promise<NormalizedEvent> {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as CfPayload
    const id = await contentId(payload)
    const tsIso = payload.ts ? new Date(payload.ts * 1000).toISOString() : new Date().toISOString()
    return {
      source: 'cloudflare-notifications',
      subName: sub.name,
      type: payload.alert_type ?? 'unknown',
      id,
      timestamp: tsIso,
      title: payload.name ?? '(cloudflare alert)',
      body: payload.text ?? '',
      severity: severityFor(payload),
      raw: payload,
    }
  },
}

export default adapter
