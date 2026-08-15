const MAX_PRIMARY_LINK_LABEL_LENGTH = 160
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/gi
const TRAILING_URL_PUNCTUATION_RE = /[),.;:!?\]}]+$/
const LEADING_LABEL_DECORATION_RE = /^[\s*#=_\-[<{]+/
const TRAILING_LABEL_DECORATION_RE = /[\s*#=_:\-([<{]+$/

export interface EmailLinkCandidate {
  label: string
  url: string
}

function httpUrlRegex(): RegExp {
  return new RegExp(HTTP_URL_RE.source, HTTP_URL_RE.flags)
}

function splitUrlPunctuation(value: string): { url: string; trailing: string } {
  const trailing = TRAILING_URL_PUNCTUATION_RE.exec(value)?.[0] ?? ''
  return {
    url: trailing ? value.slice(0, -trailing.length) : value,
    trailing,
  }
}

function candidateLabel(value: string): string {
  const withoutTrailingDecoration = value
    .trim()
    .replace(TRAILING_LABEL_DECORATION_RE, '')
    .trim()
  const markdown = /^\[([^\]]+)\]$/.exec(withoutTrailingDecoration)
  return (markdown?.[1] ?? withoutTrailingDecoration.replace(LEADING_LABEL_DECORATION_RE, '')).trim()
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

export function normalizeEmailLinkLabel(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!normalized) throw new Error('email primary link label must not be empty')
  if (normalized.length > MAX_PRIMARY_LINK_LABEL_LENGTH) {
    throw new Error(`email primary link label exceeds ${MAX_PRIMARY_LINK_LABEL_LENGTH} characters`)
  }
  if (/https?:\/\//i.test(normalized)) {
    throw new Error('email primary link label must not contain a URL')
  }
  return normalized
}

export function extractEmailLinkCandidates(value: string): EmailLinkCandidate[] {
  const candidates: EmailLinkCandidate[] = []
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    for (const match of line.matchAll(httpUrlRegex())) {
      const rawUrl = match[0]
      const { url } = splitUrlPunctuation(rawUrl)
      if (!url || !validHttpUrl(url)) continue
      candidates.push({
        label: candidateLabel(line.slice(0, match.index)),
        url,
      })
    }
  }
  return candidates
}

export function selectPrimaryEmailLink(
  value: string,
  primaryLinkLabels: string[],
): string | undefined {
  const allowedLabels = new Set<string>()
  for (const label of primaryLinkLabels) {
    try {
      allowedLabels.add(normalizeEmailLinkLabel(label))
    } catch {}
  }
  if (allowedLabels.size === 0) return undefined

  const matchingUrls = new Set(
    extractEmailLinkCandidates(value)
      .filter((candidate) => {
        if (!candidate.label) return false
        try {
          return allowedLabels.has(normalizeEmailLinkLabel(candidate.label))
        } catch {
          return false
        }
      })
      .map((candidate) => candidate.url),
  )
  return matchingUrls.size === 1 ? [...matchingUrls][0] : undefined
}

export function stripEmailUrls(value: string): string {
  return value
    .replace(httpUrlRegex(), (rawUrl) => {
      const { trailing } = splitUrlPunctuation(rawUrl)
      return trailing.replace(/[)\]}]/g, '')
    })
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s*$/gm, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
}
