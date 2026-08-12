import { describe, expect, it } from 'vitest'
import {
  normalizeDiscordWebhookUrl,
  parseSinkAddArgs,
  prepareDiscordSink,
} from '../../scripts/sink-add'
import { parseRoutes } from '../../scripts/sync'

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/fake-token'
const ROUTES = `
// Sink config remains safe to store locally
{
  "subs": [],
  "sinks": []
}
`

describe('parseSinkAddArgs', () => {
  it('accepts a named Discord sink', () => {
    expect(parseSinkAddArgs(['discord', 'discord'])).toEqual({ name: 'discord', type: 'discord', yes: false })
  })

  it('rejects unsupported sink types', () => {
    expect(() => parseSinkAddArgs(['alerts', 'slack'])).toThrow(/unsupported sink type/)
  })
})

describe('Discord sink preparation', () => {
  it('stores only the secret reference in routes and mirrors the URL into local secrets', () => {
    const prepared = prepareDiscordSink(ROUTES, 'CF_ACCESS_AUD=test\n', 'personal-alerts', DISCORD_URL)
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).toContain('// Sink config remains safe to store locally')
    expect(prepared.routesText).not.toContain(DISCORD_URL)
    expect(routes.sinks).toEqual([
      { name: 'personal-alerts', type: 'discord', urlEnv: 'SINK_PERSONAL_ALERTS_URL' },
    ])
    expect(prepared.devVarsText).toContain(`SINK_PERSONAL_ALERTS_URL=${DISCORD_URL}\n`)
    expect(prepared.secret).toEqual({ name: 'SINK_PERSONAL_ALERTS_URL', value: DISCORD_URL })
  })

  it('accepts Discord webhook hosts and rejects lookalikes or URL extras', () => {
    expect(normalizeDiscordWebhookUrl(DISCORD_URL)).toBe(DISCORD_URL)
    expect(() => normalizeDiscordWebhookUrl('https://discord.com.evil.example/api/webhooks/1/token')).toThrow()
    expect(() => normalizeDiscordWebhookUrl(`${DISCORD_URL}?wait=true`)).toThrow(/unsupported components/)
  })

  it('refuses sink-name and derived-secret collisions', () => {
    const first = prepareDiscordSink(ROUTES, '', 'discord', DISCORD_URL)
    expect(() => prepareDiscordSink(first.routesText, first.devVarsText, 'discord', DISCORD_URL)).toThrow(/already exists/)
    expect(() => prepareDiscordSink(first.routesText, '', 'DISCORD', DISCORD_URL)).toThrow(/secret name/)
  })
})
