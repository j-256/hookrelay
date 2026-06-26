import { describe, expect, it } from 'vitest'
import { hmacSha256Hex, timingSafeEqualHex } from '../../src/lib/hmac'

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
