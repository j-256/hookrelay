import { describe, expect, it } from 'vitest'
import { parseRoutes, type Sub } from '../../../scripts/sync'
import { updateManagedRoutes } from '../src/routes'

const DESIRED: Sub = {
  name: 'cloudflare-fleet',
  source: 'cloudevents',
  slugHash: 'a'.repeat(64),
  enabled: true,
  sinks: ['discord:service-status'],
  auth: { scheme: 'hookrelay-sha256', secretEnv: 'HMAC_CLOUDFLARE_FLEET' },
  filter: { eventTypes: { include: ['urn:cloudflare-fleet:endpoint:problem:v1'] } },
}

const ROUTES = `{
  // Preserve this deployment comment
  "baseUrl": "https://hooks.example.com",
  "subs": [],
  "sinks": [
    { "name": "discord:service-status", "type": "discord", "urlEnv": "SINK_STATUS_URL" }
  ]
}\n`

describe('managed subscription route updates', () => {
  it('adds a hash-only route while preserving unrelated comments', () => {
    const result = updateManagedRoutes(ROUTES, [], new Map([[DESIRED.name, DESIRED]]))
    expect(result.additions).toEqual(['cloudflare-fleet'])
    expect(result.routesText).toContain('// Preserve this deployment comment')
    expect(result.routesText).not.toContain('private-slug')
    expect(parseRoutes(result.routesText).subs).toEqual([DESIRED])
  })

  it('updates routing fields but refuses identity drift', () => {
    const initial = updateManagedRoutes(ROUTES, [], new Map([[DESIRED.name, DESIRED]]))
    const existing = parseRoutes(initial.routesText).subs
    const changed = { ...DESIRED, sinks: ['discord:other'] }
    const updated = updateManagedRoutes(initial.routesText, existing, new Map([[DESIRED.name, changed]]))
    expect(updated.updates).toEqual(['cloudflare-fleet'])
    expect(parseRoutes(updated.routesText).subs[0]?.sinks).toEqual(['discord:other'])

    expect(() => updateManagedRoutes(initial.routesText, existing, new Map([[
      DESIRED.name,
      { ...DESIRED, slugHash: 'b'.repeat(64) },
    ]]))).toThrow(/route identity differs \(slug hash\)/)
  })

  it('rejects collisions with unrelated routes', () => {
    const collision = { ...DESIRED, name: 'unrelated' }
    expect(() => updateManagedRoutes(ROUTES, [collision], new Map([[DESIRED.name, DESIRED]])))
      .toThrow(/slug hash is already owned/)
  })
})
