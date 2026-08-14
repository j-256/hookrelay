import { SUBSCRIPTION_SLUG_RE } from './subscription'

export const EMAIL_SOURCE = 'email'
export const EMAIL_EVENT_TYPE = 'email.received'

const EMAIL_DOMAIN_LABEL_PATTERN = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const EMAIL_DOMAIN_PATTERN = `${EMAIL_DOMAIN_LABEL_PATTERN}(?:\\.${EMAIL_DOMAIN_LABEL_PATTERN})*`
const EMAIL_ADDRESS_RE = new RegExp(`^[^\\s@]+@${EMAIL_DOMAIN_PATTERN}$`, 'i')
const EMAIL_DOMAIN_RULE_RE = new RegExp(`^@${EMAIL_DOMAIN_PATTERN}$`, 'i')

export interface ParsedEmailRoute {
  slug: string
}

export function normalizeEmailRouteSlug(value: string): string {
  const normalized = value.toLowerCase()
  if (!SUBSCRIPTION_SLUG_RE.test(normalized)) throw new Error('invalid email route slug')
  return normalized
}

export function parseEmailRoute(address: string): ParsedEmailRoute | null {
  const at = address.lastIndexOf('@')
  if (at <= 0 || at === address.length - 1) return null
  const local = address.slice(0, at)
  const separator = local.lastIndexOf('+')
  if (separator <= 0) return null
  const slug = local.slice(separator + 1).toLowerCase()
  if (!SUBSCRIPTION_SLUG_RE.test(slug)) return null
  return { slug }
}

export function redactEmailRoute(address: string): string {
  const route = parseEmailRoute(address)
  if (!route) return address
  const at = address.lastIndexOf('@')
  const local = address.slice(0, at)
  const separator = local.lastIndexOf('+')
  return `${local.slice(0, separator)}+<redacted>${address.slice(at)}`
}

export function normalizeEmailBaseAddress(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!EMAIL_ADDRESS_RE.test(normalized)) throw new Error(`invalid email base address: ${value}`)
  const local = normalized.slice(0, normalized.lastIndexOf('@'))
  if (local.includes('+')) throw new Error('email base address must not contain plus addressing')
  return normalized
}

export function routedEmailAddress(baseAddress: string, slug: string): string {
  const normalized = normalizeEmailBaseAddress(baseAddress)
  const normalizedSlug = normalizeEmailRouteSlug(slug)
  const at = normalized.lastIndexOf('@')
  return `${normalized.slice(0, at)}+${normalizedSlug}${normalized.slice(at)}`
}

export function normalizeSenderRule(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('@')) {
    if (!EMAIL_DOMAIN_RULE_RE.test(normalized)) {
      throw new Error(`invalid sender domain rule: ${value}`)
    }
    return normalized
  }
  if (!EMAIL_ADDRESS_RE.test(normalized)) {
    throw new Error(`invalid sender address rule: ${value}`)
  }
  return normalized
}

export function senderMatchesRule(address: string, rule: string): boolean {
  const normalizedAddress = address.trim().toLowerCase()
  const normalizedRule = normalizeSenderRule(rule)
  return normalizedRule.startsWith('@')
    ? normalizedAddress.endsWith(normalizedRule)
    : normalizedAddress === normalizedRule
}
