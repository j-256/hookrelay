export function normalizeFallbackUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('fallback URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('fallback URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('fallback URL must not contain credentials, a query, or a fragment')
  }
  return url.toString()
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [first, second] = parts as [number, number, number, number]
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateIpv4(host)
  ) return true
  if (!host.includes(':')) return false
  return host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    /^fe[89ab]/.test(host) ||
    host.startsWith('ff') ||
    host.startsWith('::ffff:')
}

function parsePublicHttpsUrl(value: string, label: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`${label} is invalid`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`)
  if (isPrivateHostname(url.hostname)) throw new Error(`${label} must use a public host`)
  return url
}

export function normalizeCloudEventUrl(value: string): string {
  return parsePublicHttpsUrl(value, 'CloudEvent URL').toString()
}

export function normalizeWebhookEndpointUrl(value: string): string {
  const url = parsePublicHttpsUrl(value, 'webhook endpoint URL')
  if (url.hash) throw new Error('webhook endpoint URL must not contain a fragment')
  return url.toString()
}
