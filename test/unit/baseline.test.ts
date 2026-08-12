import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('baseline worker', () => {
  it('redirects the admin root to the event dashboard', async () => {
    const res = await SELF.fetch('https://hooks.example.com/admin?source=github', {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://hooks.example.com/admin/events?source=github')
  })

  it('returns 404 for unknown paths', async () => {
    const res = await SELF.fetch('https://hooks.example.com/unknown')
    expect(res.status).toBe(404)
  })
})
