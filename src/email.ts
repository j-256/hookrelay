import PostalMime, { type Address, type Email } from 'postal-mime'
import { ingestEvent } from './ingest'
import type { Env } from './index'
import {
  EMAIL_EVENT_TYPE,
  EMAIL_SOURCE,
  normalizeSenderRule,
  parseEmailRoute,
  redactEmailRoute,
  senderMatchesRule,
} from './lib/email-address'
import {
  selectPrimaryEmailLink,
  stripEmailUrls,
} from './lib/email-links'
import { withSubscriptionFallbackUrl } from './lib/event-url'
import {
  hashSubscriptionSlug,
  subscriptionKvKey,
} from './lib/subscription'
import type { NormalizedEvent, Subscription } from './types'

const MAX_EMAIL_BYTES = 1024 * 1024
const EMPTY_SUBJECT = '(no subject)'
const EMPTY_BODY = '(empty email body)'
const RAW_EMAIL_CONTENT_TYPE = 'message/rfc822'

export interface IncomingEmailMessage {
  from: string
  to: string
  headers: Headers
  raw: ReadableStream<Uint8Array>
  rawSize: number
  setReject(reason: string): void
}

export {
  normalizeSenderRule,
  parseEmailRoute,
  redactEmailRoute,
  senderMatchesRule,
} from './lib/email-address'

export class EmailRejection extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message)
    this.name = 'EmailRejection'
  }
}

function reject(reason: string, message = reason): never {
  throw new EmailRejection(message, reason)
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (entity, key: string) => {
    if (key.startsWith('#')) {
      const hexadecimal = key[1]?.toLowerCase() === 'x'
      const digits = hexadecimal ? key.slice(2) : key.slice(1)
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
      if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint)
        } catch {
          return entity
        }
      }
      return entity
    }
    return named[key.toLowerCase()] ?? entity
  })
}

function collapseText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function htmlToPlainText(html: string): string {
  const withoutHiddenContent = html
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(head|script|style|svg)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
  const withLinks = withoutHiddenContent.replace(
    /<a\b[^>]*\bhref\s*=\s*(?:"(https?:\/\/[^"<>]+)"|'(https?:\/\/[^'<>]+)'|(https?:\/\/[^\s>]+))[^>]*>([^]*?)<\/a\s*>/gi,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined, labelHtml: string) => {
      const url = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? '')
      const label = collapseText(decodeHtmlEntities(labelHtml.replace(/<[^>]+>/g, ' ')))
      return label && label !== url ? `${label} (${url})` : url
    },
  )
  return collapseText(decodeHtmlEntities(
    withLinks
      .replace(/<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_match, first: string, second: string) => first ?? second ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:address|article|aside|blockquote|div|footer|h[1-6]|header|li|main|p|section|table|tr)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' '),
  ))
}

function addressMailboxes(address: Address | undefined): string[] {
  if (!address) return []
  if ('group' in address && address.group) return address.group.map((mailbox) => mailbox.address)
  return address.address ? [address.address] : []
}

function headerSenderAddresses(email: Email): string[] {
  return [...addressMailboxes(email.from), ...addressMailboxes(email.sender)]
}

function enforceAllowedSenders(
  envelopeFrom: string,
  email: Email,
  allowedSenders: string[],
): void {
  if (allowedSenders.length === 0) return
  const identities = [envelopeFrom, ...headerSenderAddresses(email)]
  if (identities.some((address) => !allowedSenders.some((rule) => senderMatchesRule(address, rule)))) {
    reject('Sender not allowed', 'email sender does not match the subscription allowlist')
  }
}

function parseTimestamp(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString()
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.valueOf()) ? fallback.toISOString() : timestamp.toISOString()
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function emailMetadata(email: Email, message: IncomingEmailMessage): unknown {
  return {
    envelope: { from: message.from, to: redactEmailRoute(message.to) },
    headers: {
      from: addressMailboxes(email.from),
      sender: addressMailboxes(email.sender),
      to: (email.to ?? []).flatMap(addressMailboxes).map(redactEmailRoute),
      subject: email.subject ? stripEmailUrls(email.subject) || null : null,
      messageId: email.messageId ?? null,
      date: email.date ?? null,
    },
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId: attachment.contentId ?? null,
      size: typeof attachment.content === 'string'
        ? new TextEncoder().encode(attachment.content).byteLength
        : attachment.content.byteLength,
    })),
  }
}

export async function normalizeEmail(
  rawMessage: Uint8Array,
  message: IncomingEmailMessage,
  subscription: Subscription,
  subscriptionHash: string,
  receivedAt = new Date(),
): Promise<NormalizedEvent> {
  let parsed: Email
  try {
    parsed = await PostalMime.parse(rawMessage)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    reject('Malformed email', `failed to parse email: ${message}`)
  }

  const allowedSenders = subscription.email?.allowedSenders ?? []
  enforceAllowedSenders(message.from, parsed, allowedSenders)

  const plainText = collapseText(parsed.text ?? '')
  const htmlText = parsed.html ? htmlToPlainText(parsed.html) : ''
  const unsafeBody = plainText || htmlText || EMPTY_BODY
  const selectedUrl = selectPrimaryEmailLink(
    unsafeBody,
    subscription.email?.primaryLinkLabels ?? [],
  )
  const body = collapseText(stripEmailUrls(unsafeBody)) || EMPTY_BODY
  const identity = parsed.messageId
    ? new TextEncoder().encode(parsed.messageId.trim())
    : rawMessage
  const identityHash = await sha256(identity)

  return withSubscriptionFallbackUrl({
    source: EMAIL_SOURCE,
    subName: subscription.name,
    type: EMAIL_EVENT_TYPE,
    id: `${subscriptionHash}:${identityHash}`,
    timestamp: parseTimestamp(parsed.date, receivedAt),
    title: collapseText(stripEmailUrls(parsed.subject ?? '')) || EMPTY_SUBJECT,
    body,
    url: selectedUrl,
    severity: 'info',
    raw: emailMetadata(parsed, message),
  }, subscription)
}

async function loadSubscription(
  env: Env,
  slug: string,
): Promise<{ subscription: Subscription; hash: string }> {
  const hash = await hashSubscriptionSlug(slug)
  const rawSubscription = await env.SUBS.get(subscriptionKvKey(hash))
  if (!rawSubscription) reject('Unknown email route')

  let subscription: Subscription
  try {
    subscription = JSON.parse(rawSubscription) as Subscription
  } catch {
    console.log(JSON.stringify({ level: 'error', msg: 'sub.json.invalid', source: EMAIL_SOURCE }))
    reject('Email route unavailable')
  }
  if (subscription.source !== EMAIL_SOURCE || !subscription.email) {
    reject('Unknown email route')
  }
  return { subscription, hash }
}

async function cancelRawMessage(message: IncomingEmailMessage): Promise<void> {
  try {
    await message.raw.cancel()
  } catch {}
}

export async function handleEmail(
  message: IncomingEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  try {
    if (message.rawSize > MAX_EMAIL_BYTES) reject('Message too large')
    const route = parseEmailRoute(message.to)
    if (!route) reject('Unknown email route')
    const { subscription, hash } = await loadSubscription(env, route.slug)
    if (!subscription.enabled) {
      await cancelRawMessage(message)
      return
    }

    const rawMessage = new Uint8Array(await new Response(message.raw).arrayBuffer())
    if (rawMessage.byteLength > MAX_EMAIL_BYTES) reject('Message too large')
    const event = await normalizeEmail(rawMessage, message, subscription, hash)
    await ingestEvent(
      env,
      event,
      rawMessage,
      RAW_EMAIL_CONTENT_TYPE,
      hash,
      subscription.sinks,
    )
  } catch (err) {
    if (!(err instanceof EmailRejection)) throw err
    await cancelRawMessage(message)
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'email.rejected',
      reason: err.reason,
      envelopeFrom: message.from,
    }))
    message.setReject(err.reason)
  }
}
