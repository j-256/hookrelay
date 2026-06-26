export interface AccessConfig {
  teamDomain: string // e.g. "your-team" -> https://your-team.cloudflareaccess.com
  audience: string // CF Access application AUD tag
  fetch?: typeof fetch
}

export interface AccessIdentity {
  email: string
  sub: string
}

interface JwtHeader {
  alg: string
  kid?: string
}

interface JwtPayload {
  aud?: string | string[]
  email?: string
  sub?: string
  exp?: number
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n?: string
  e?: string
}

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const jwksCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>()

async function getJwks(teamDomain: string, fetchFn: typeof fetch): Promise<Jwk[] | null> {
  const cached = jwksCache.get(teamDomain)
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) return cached.keys

  const url = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`
  const res = await fetchFn(url)
  if (res.status >= 400) return null
  const json = (await res.json()) as { keys?: Jwk[] }
  const keys = json.keys ?? []
  jwksCache.set(teamDomain, { fetchedAt: Date.now(), keys })
  return keys
}

function decodeBase64url(s: string): Uint8Array {
  // Browser-safe base64url -> Uint8Array
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJson(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64url(s)))
}

async function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

export async function verifyAccessJwt(
  req: Request,
  cfg: AccessConfig,
): Promise<AccessIdentity | null> {
  const fetchFn = cfg.fetch ?? fetch
  const token = req.headers.get('cf-access-jwt-assertion')
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]

  let header: JwtHeader
  let payload: JwtPayload
  try {
    header = decodeJson(headerB64) as JwtHeader
    payload = decodeJson(payloadB64) as JwtPayload
  } catch {
    return null
  }

  if (header.alg !== 'RS256') return null

  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(cfg.audience)
    : payload.aud === cfg.audience
  if (!audMatches) return null

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null
  }

  const keys = await getJwks(cfg.teamDomain, fetchFn)
  if (!keys) return null

  if (!header.kid || typeof header.kid !== 'string') return null
  const jwk = keys.find((k) => k.kid === header.kid)
  if (!jwk) return null

  let pubkey: CryptoKey
  try {
    pubkey = await importJwk(jwk)
  } catch {
    return null
  }

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const sig = decodeBase64url(sigB64)

  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pubkey, sig, data)
  if (!ok) return null

  return {
    email: typeof payload.email === 'string' ? payload.email : '',
    sub: typeof payload.sub === 'string' ? payload.sub : '',
  }
}
