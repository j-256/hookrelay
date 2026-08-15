export type Severity = 'debug' | 'info' | 'warning' | 'error' | 'critical'

export interface NormalizedEvent {
  source: string
  subName: string
  type: string
  id: string
  timestamp: string
  title: string
  body: string
  url?: string
  severity?: Severity
  shouldDeliver?: boolean
  raw: unknown
}

export interface SubAuth {
  scheme: string
  secretEnv: string
  alternateSecretEnvs?: string[]
}

export interface EmailSubscriptionConfig {
  allowedSenders: string[]
  primaryLinkLabels?: string[]
}

export interface Subscription {
  name: string
  source: string
  enabled: boolean
  sinks: string[]
  auth: SubAuth | null
  fallbackUrl?: string
  email?: EmailSubscriptionConfig
}

export type DeliveryStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'delivered'
  | 'exhausted'

export interface FanoutResult {
  ok: boolean
  status?: DeliveryStatus
  attempts?: number
  errMsg?: string
  updatedAt?: string
}

export type FanoutResults = Record<string, FanoutResult>

export interface DeliveryMessage {
  version: 1
  eventId: string
  sinkName: string
  generation: number
}
