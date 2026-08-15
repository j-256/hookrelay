export const SEVERITIES = ['debug', 'info', 'warning', 'error', 'critical'] as const
export type Severity = (typeof SEVERITIES)[number]

export const DELIVERY_DECISION_REASONS = [
  'source-record-only',
  'subscription-filter',
  'sink-filter',
] as const
export type DeliveryDecisionReason = (typeof DELIVERY_DECISION_REASONS)[number]

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
  deliveryDecisionReason?: DeliveryDecisionReason
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

export interface EventTypeFilter {
  include?: string[]
  exclude?: string[]
}

export interface SeverityFilter {
  include?: Severity[]
  exclude?: Severity[]
}

export interface EventFilter {
  eventTypes?: EventTypeFilter
  severities?: SeverityFilter
}

export type SubscriptionFilter = EventFilter

export interface Subscription {
  name: string
  source: string
  enabled: boolean
  sinks: string[]
  auth: SubAuth | null
  fallbackUrl?: string
  email?: EmailSubscriptionConfig
  filter?: SubscriptionFilter
  sinkFilters?: Record<string, EventFilter>
}

export type DeliveryStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'delivered'
  | 'filtered'
  | 'exhausted'

export interface FanoutResult {
  ok: boolean
  status?: DeliveryStatus
  attempts?: number
  errMsg?: string
  decisionReason?: DeliveryDecisionReason
  updatedAt?: string
}

export type FanoutResults = Record<string, FanoutResult>

export type DeliveryPlan =
  | { sinkName: string; deliver: true }
  | { sinkName: string; deliver: false; decisionReason: DeliveryDecisionReason }

export interface DeliveryMessage {
  version: 1
  eventId: string
  sinkName: string
  generation: number
}
