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
  raw: unknown
}

export interface SubAuth {
  scheme: string
  secretEnv: string
}

export interface Subscription {
  name: string
  source: string
  enabled: boolean
  sinks: string[]
  auth: SubAuth | null
}

export interface FanoutResult {
  ok: boolean
  errMsg?: string
}

export type FanoutResults = Record<string, FanoutResult>
