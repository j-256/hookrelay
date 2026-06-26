import { describe, expect, it } from 'vitest'
import uptime from '../../../src/adapters/uptime'
import type { Subscription } from '../../../src/types'
import down from '../../fixtures/uptime/down.json'
import up from '../../fixtures/uptime/up.json'

const sub: Subscription = { name: 'example-monitor', source: 'uptime', enabled: true, sinks: [], auth: null }

const make = (body: unknown) => {
  const raw = new TextEncoder().encode(JSON.stringify(body))
  const req = new Request('https://hooks.example.com/hook/uptime/abc', {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json' },
  })
  return { req, raw }
}

describe('uptime adapter', () => {
  it('verify is a no-op (no sender-side auth)', async () => {
    const { req, raw } = make(down)
    await expect(uptime.verify(req, raw, sub, {} as never)).resolves.toBeUndefined()
  })

  it('parses alertType=1 as monitor.down with error severity', async () => {
    const { req, raw } = make(down)
    const event = await uptime.parse(req, raw, sub)
    expect(event.type).toBe('monitor.down')
    expect(event.severity).toBe('error')
    expect(event.title).toContain('status.example.com')
    expect(event.title).toContain('Down')
    expect(event.url).toBe('https://status.example.com')
  })

  it('parses alertType=2 as monitor.up with info severity', async () => {
    const { req, raw } = make(up)
    const event = await uptime.parse(req, raw, sub)
    expect(event.type).toBe('monitor.up')
    expect(event.severity).toBe('info')
  })

  it('produces a stable id per payload and a different id when alertDateTime differs', async () => {
    const { req: req1, raw: raw1 } = make(down)
    const { req: req2, raw: raw2 } = make(down)
    const a = await uptime.parse(req1, raw1, sub)
    const b = await uptime.parse(req2, raw2, sub)
    expect(a.id).toBe(b.id)

    const { req: req3, raw: raw3 } = make({ ...down, alertDateTime: String(Number(down.alertDateTime) + 60) })
    const c = await uptime.parse(req3, raw3, sub)
    expect(c.id).not.toBe(a.id)
  })

  it('throws when alertDateTime is missing (forces a docs hint)', async () => {
    const payload = { ...down } as Record<string, unknown>
    delete payload.alertDateTime
    const { req, raw } = make(payload)
    await expect(uptime.parse(req, raw, sub)).rejects.toThrow(/alertDateTime/)
  })
})
