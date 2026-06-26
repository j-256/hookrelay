import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('baseline worker', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await SELF.fetch('https://hooks.example.com/unknown')
    expect(res.status).toBe(404)
  })
})
