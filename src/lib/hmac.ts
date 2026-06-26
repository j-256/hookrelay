function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, body)
  return toHex(sig)
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Compare against itself to keep timing similar regardless of length mismatch
    let acc = 1
    for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ a.charCodeAt(i)
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Hex strings are strings -- this alias keeps existing callers working
export const timingSafeEqualHex = timingSafeEqualString
