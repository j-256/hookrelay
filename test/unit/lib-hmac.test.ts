import { describe, expect, it } from 'vitest'
import {
  hmacSha256Hex,
  hmacSha256MatchesAny,
  parseHmacSha256Header,
  sha256Hex,
  timingSafeEqualHex,
} from '../../src/lib/hmac'

describe('hmacSha256Hex', () => {
  it('produces stable hex digest for known inputs', async () => {
    // Known vector: HMAC-SHA256 of "hello" with key "secret"
    const got = await hmacSha256Hex('secret', new TextEncoder().encode('hello'))
    expect(got).toBe('88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b')
  })

  it('differs when key differs', async () => {
    const a = await hmacSha256Hex('secret-a', new TextEncoder().encode('hello'))
    const b = await hmacSha256Hex('secret-b', new TextEncoder().encode('hello'))
    expect(a).not.toBe(b)
  })
})

describe('generic digest and signature helpers', () => {
  it('produces the standard SHA-256 digest vector', async () => {
    expect(await sha256Hex(new TextEncoder().encode('hello')))
      .toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('parses only canonical lowercase HMAC headers', () => {
    const digest = 'a'.repeat(64)
    expect(parseHmacSha256Header(`sha256=${digest}`)).toBe(digest)
    expect(parseHmacSha256Header(`SHA256=${digest}`)).toBeNull()
    expect(parseHmacSha256Header(`sha256=${digest.toUpperCase()}`)).toBeNull()
    expect(parseHmacSha256Header('sha256=abc')).toBeNull()
  })

  it('matches any available rotation secret', async () => {
    const body = new TextEncoder().encode('payload')
    const signature = await hmacSha256Hex('next', body)
    await expect(hmacSha256MatchesAny(['primary', 'next'], body, signature)).resolves.toBe(true)
    await expect(hmacSha256MatchesAny(['primary'], body, signature)).resolves.toBe(false)
  })
})

describe('timingSafeEqualHex', () => {
  it('returns true for equal hex strings', () => {
    expect(timingSafeEqualHex('deadbeef', 'deadbeef')).toBe(true)
  })

  it('returns false for differing hex strings of same length', () => {
    expect(timingSafeEqualHex('deadbeef', 'beefdead')).toBe(false)
  })

  it('returns false for differing lengths without short-circuiting', () => {
    expect(timingSafeEqualHex('aa', 'aabb')).toBe(false)
  })
})
