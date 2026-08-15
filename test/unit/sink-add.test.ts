import { describe, expect, it } from 'vitest'
import {
  normalizeDiscordWebhookUrl,
  parseSinkAddArgs,
  prepareDiscordSink,
  prepareWebhookSink,
} from '../../scripts/sink-add'
import { parseRoutes } from '../../scripts/sync'

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/fake-token'
const WEBHOOK_URL = 'https://receiver.example.com/hooks?tenant=hookrelay'
const WEBHOOK_SECRET = 'generated-signing-secret'
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

  it('accepts a named generic webhook sink', () => {
    expect(parseSinkAddArgs(['automation', 'webhook'])).toEqual({
      name: 'automation',
      type: 'webhook',
      yes: false,
    })
  })

  it('accepts -y and rejects unknown short options', () => {
    expect(parseSinkAddArgs(['discord', 'discord', '-y'])).toEqual({ name: 'discord', type: 'discord', yes: true })
    expect(() => parseSinkAddArgs(['discord', 'discord', '-x'])).toThrow(/unknown option: -x/)
  })

  it('rejects unsupported sink types', () => {
    expect(() => parseSinkAddArgs(['alerts', 'slack'])).toThrow(/unsupported sink type/)
  })
})

describe('generic webhook sink preparation', () => {
  it('stores only secret references while preparing both local secrets', () => {
    const prepared = prepareWebhookSink(
      ROUTES,
      'CF_ACCESS_AUD=test\n',
      'automation',
      WEBHOOK_URL,
      WEBHOOK_SECRET,
    )
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).not.toContain(WEBHOOK_URL)
    expect(prepared.routesText).not.toContain(WEBHOOK_SECRET)
    expect(routes.sinks).toEqual([{
      name: 'automation',
      type: 'webhook',
      urlEnv: 'SINK_AUTOMATION_URL',
      signingSecretEnv: 'SINK_AUTOMATION_SIGNING_SECRET',
    }])
    expect(prepared.devVarsText).toContain(`SINK_AUTOMATION_URL=${WEBHOOK_URL}\n`)
    expect(prepared.devVarsText).toContain(`SINK_AUTOMATION_SIGNING_SECRET=${WEBHOOK_SECRET}\n`)
    expect(prepared.secrets).toEqual([
      { name: 'SINK_AUTOMATION_URL', value: WEBHOOK_URL },
      { name: 'SINK_AUTOMATION_SIGNING_SECRET', value: WEBHOOK_SECRET },
    ])
  })

  it('rejects private endpoints, fragments, and derived secret collisions', () => {
    expect(() => prepareWebhookSink(ROUTES, '', 'local', 'https://127.0.0.1/hook', WEBHOOK_SECRET))
      .toThrow(/public host/)
    expect(() => prepareWebhookSink(ROUTES, '', 'fragment', `${WEBHOOK_URL}#secret`, WEBHOOK_SECRET))
      .toThrow(/fragment/)
    const first = prepareWebhookSink(ROUTES, '', 'automation', WEBHOOK_URL, WEBHOOK_SECRET)
    expect(() => prepareWebhookSink(first.routesText, '', 'AUTOMATION', WEBHOOK_URL, WEBHOOK_SECRET))
      .toThrow(/secret name|already exists/)
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
    const retired = ROUTES.replace(
      '"sinks": []',
      '"sinks": [],\n  "retiredSinks": [{ "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" }]',
    )
    expect(() => prepareDiscordSink(retired, '', 'discord', DISCORD_URL)).toThrow(/already exists/)
  })
})
