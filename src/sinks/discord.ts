import { z } from 'zod'
import type { Sink } from '.'
import type { Env } from '../index'
import { postJson } from '../lib/http'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, Severity } from '../types'

const COLOR: Record<Severity, number> = {
  debug: 0x99aab5,
  info: 0x3498db,
  warning: 0xfee75c,
  error: 0xed4245,
  critical: 0x8b0000,
}

const DISCORD_DESCRIPTION_LIMIT = 4096
const DISCORD_TITLE_LIMIT = 256
const JSON_INDENT_SPACES = 2
const JSON_BLOCK_OPEN = '```json\n'
const JSON_BLOCK_CLOSE = '\n```'
const JSON_TOKEN_PATTERN = /"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g
const DESCRIPTION_TRUNCATED = '\n\n*Content truncated*'
const DESCRIPTION_TRUNCATED_WITH_URL = '\n\n*Content truncated; open the title for the full event*'
const TRUNCATION_BOUNDARY_MINIMUM_RATIO = 0.75
const HTML_COMMENT_PATTERN = /<!--(?:[\s\S]*?-->|[\s\S]*$)/g
const HTML_COMMENT_REPLACEMENT = ' '
const HTML_BREAK_PATTERN = /<br(?:\s[^<>]*?)?\s*\/?>/gi
const HTML_LIST_ITEM_OPEN_PATTERN = /<li(?:\s[^<>]*?)?\s*>/gi
const HTML_LIST_ITEM_CLOSE_PATTERN = /<\/li\s*>[ \t]*(?:\r?\n)?/gi
const HTML_BLOCK_TAG_PATTERN = /<\/?(?:blockquote|details|div|h[1-6]|ol|p|pre|summary|table|tbody|td|tfoot|th|thead|tr|ul)(?:\s[^<>]*?)?\s*>/gi
const HTML_INLINE_TAG_PATTERN = /<\/?(?:a|abbr|b|cite|code|del|em|i|img|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)(?:\s[^<>]*?)?\s*\/?>/gi
const TRAILING_LINE_WHITESPACE_PATTERN = /[ \t]+\n/g
const EXCESS_BLANK_LINES_PATTERN = /\n{3,}/g
const TRAILING_HIGH_SURROGATE_PATTERN = /[\uD800-\uDBFF]$/u

const configSchema = z
  .object({
    urlEnv: z.string().min(1),
  })
  .strict()

type Config = z.infer<typeof configSchema>

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

function normalizeDescription(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(HTML_COMMENT_PATTERN, HTML_COMMENT_REPLACEMENT)
    .replace(HTML_BREAK_PATTERN, '\n')
    .replace(HTML_LIST_ITEM_OPEN_PATTERN, '- ')
    .replace(HTML_LIST_ITEM_CLOSE_PATTERN, '\n')
    .replace(HTML_BLOCK_TAG_PATTERN, '\n')
    .replace(HTML_INLINE_TAG_PATTERN, '')
    .replace(TRAILING_LINE_WHITESPACE_PATTERN, '\n')
    .replace(EXCESS_BLANK_LINES_PATTERN, '\n\n')
    .trim()
}

function truncateDescription(s: string, hasUrl: boolean, maximum = DISCORD_DESCRIPTION_LIMIT): string {
  if (s.length <= maximum) return s

  const suffix = hasUrl ? DESCRIPTION_TRUNCATED_WITH_URL : DESCRIPTION_TRUNCATED
  const available = maximum - suffix.length
  const candidate = s.slice(0, available)
  const minimumBoundary = Math.floor(available * TRUNCATION_BOUNDARY_MINIMUM_RATIO)
  const lineBoundary = candidate.lastIndexOf('\n')
  const wordBoundary = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\t'))
  const boundary = lineBoundary >= minimumBoundary
    ? lineBoundary
    : wordBoundary >= minimumBoundary ? wordBoundary : available
  const prefix = candidate
    .slice(0, boundary)
    .replace(TRAILING_HIGH_SURROGATE_PATTERN, '')
    .trimEnd()
  return `${prefix}${suffix}`
}

function prettyJson(body: string): string {
  const maximum = DISCORD_DESCRIPTION_LIMIT + 1
  let output = ''
  let depth = 0
  let previous = ''
  const append = (value: string) => {
    output += value.slice(0, maximum - output.length)
  }
  const newline = () => append(`\n${' '.repeat(depth * JSON_INDENT_SPACES)}`)
  for (const [token] of body.matchAll(JSON_TOKEN_PATTERN)) {
    if (output.length === maximum) break
    if (token === '}' || token === ']') {
      depth -= 1
      if (previous !== '{' && previous !== '[') newline()
      append(token)
    } else if (token === ',') {
      append(token)
      newline()
    } else if (token === ':') {
      append(': ')
    } else {
      if (previous === '{' || previous === '[') newline()
      append(token.replace(/`/g, '\\u0060'))
      if (token === '{' || token === '[') depth += 1
    }
    previous = token
  }
  return output
}

function jsonDescription(body: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const json = prettyJson(body)
  const maximum = DISCORD_DESCRIPTION_LIMIT - JSON_BLOCK_OPEN.length - JSON_BLOCK_CLOSE.length
  if (json.length <= maximum) return `${JSON_BLOCK_OPEN}${json}${JSON_BLOCK_CLOSE}`

  const truncated = truncateDescription(json, false, maximum)
  const suffix = DESCRIPTION_TRUNCATED
  const prefix = truncated.slice(0, -suffix.length)
  return `${JSON_BLOCK_OPEN}${prefix}${JSON_BLOCK_CLOSE}${suffix}`
}

const sink: Sink<Config> = {
  type: 'discord',
  configSchema,

  async send(event: NormalizedEvent, config: Config, env: Env, _context, fetchFn?: typeof fetch) {
    const url = readSecret(env, config.urlEnv)
    const color = COLOR[event.severity ?? 'info']
    const hasUrl = event.url !== undefined
    const body = event.summary ?? event.body
    const description = jsonDescription(body)
      ?? truncateDescription(normalizeDescription(body), hasUrl)
    const payload = {
      username: 'hookrelay',
      embeds: [
        {
          title: truncate(event.title, DISCORD_TITLE_LIMIT),
          description,
          url: event.url,
          color,
          timestamp: event.timestamp,
          footer: { text: `${event.source} / ${event.subName} / ${event.type}` },
        },
      ],
    }
    await postJson(url, payload, { fetch: fetchFn, redirect: 'manual', errorLabel: 'notification destination', includeResponseBody: false })
  },
}

export default sink
