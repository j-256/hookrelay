export interface SenderAuthProfile {
  scheme: string
  secretEnvPrefix: string
}

export interface SubscriptionSourceProfile {
  senderAuth: SenderAuthProfile | null
}

export const SOURCE_PROFILES = Object.freeze({
  statuspage: Object.freeze({ senderAuth: null }),
  github: Object.freeze({
    senderAuth: Object.freeze({
      scheme: 'github-sha256',
      secretEnvPrefix: 'HMAC',
    }),
  }),
  'cloudflare-notifications': Object.freeze({
    senderAuth: Object.freeze({
      scheme: 'cf-shared-secret',
      secretEnvPrefix: 'AUTH',
    }),
  }),
  uptime: Object.freeze({ senderAuth: null }),
} satisfies Record<string, SubscriptionSourceProfile>)

export type SubscriptionSource = keyof typeof SOURCE_PROFILES

export const KNOWN_SOURCE_TYPES = Object.freeze(Object.keys(SOURCE_PROFILES) as SubscriptionSource[])

export function getSourceProfile(source: string): SubscriptionSourceProfile | null {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_PROFILES, source)) return null
  return SOURCE_PROFILES[source as SubscriptionSource]
}
