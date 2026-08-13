import { describe, expect, it } from 'vitest'
import {
  finalizeSinkRename,
  parseSinkRenameArgs,
  prepareSinkRename,
  sinkRenameUsage,
  switchSinkRename,
} from '../../scripts/sink-rename'
import { parseRoutes } from '../../scripts/sync'

const DISCORD_URL = 'https://discord.com/api/webhooks/123456789/fake-token'
const ROUTES = `
// Preserve this routes comment
{
  "subs": [
    {
      "name": "status",
      "source": "statuspage",
      "slugHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "enabled": true,
      "sinks": ["discord"],
      "auth": null
    },
    {
      "name": "combined",
      "source": "github",
      "slugHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "enabled": true,
      "sinks": ["discord", "discord-service-status"],
      "auth": null
    }
  ],
  "sinks": [
    { "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" }
  ]
}
`

describe('parseSinkRenameArgs', () => {
  it('uses prepare by default and accepts explicit later phases', () => {
    expect(parseSinkRenameArgs(['discord', 'discord-service-status'])).toEqual({
      oldName: 'discord',
      newName: 'discord-service-status',
      phase: 'prepare',
      yes: false,
    })
    expect(parseSinkRenameArgs(['discord', 'service', '--switch', '-y']).phase).toBe('switch')
    expect(parseSinkRenameArgs(['discord', 'service', '--finalize']).phase).toBe('finalize')
  })

  it('rejects conflicting phases, identical names, and unknown options', () => {
    expect(() => parseSinkRenameArgs(['discord', 'service', '--switch', '--finalize'])).toThrow(/only one/)
    expect(() => parseSinkRenameArgs(['discord', 'discord'])).toThrow(/must differ/)
    expect(() => parseSinkRenameArgs(['discord', 'service', '-x'])).toThrow(/unknown option/)
    expect(sinkRenameUsage()).toContain('--finalize')
  })
})

describe('prepareSinkRename', () => {
  it('deploys compatible aliases that both use the new secret before routing switches', () => {
    const prepared = prepareSinkRename(
      ROUTES.replace(', "discord-service-status"', ''),
      `CF_ACCESS_AUD=test\nSINK_DISCORD_URL=${DISCORD_URL}\n`,
      'discord',
      'discord-service-status',
    )
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).toContain('// Preserve this routes comment')
    expect(routes.sinks).toEqual([
      { name: 'discord', type: 'discord', urlEnv: 'SINK_DISCORD_SERVICE_STATUS_URL' },
      { name: 'discord-service-status', type: 'discord', urlEnv: 'SINK_DISCORD_SERVICE_STATUS_URL' },
    ])
    expect(routes.subs.map((sub) => sub.sinks)).toEqual([['discord'], ['discord']])
    expect(prepared.devVarsText).toContain(`SINK_DISCORD_URL=${DISCORD_URL}\n`)
    expect(prepared.devVarsText).toContain(`SINK_DISCORD_SERVICE_STATUS_URL=${DISCORD_URL}\n`)
    expect(prepared.secrets).toEqual([
      {
        oldName: 'SINK_DISCORD_URL',
        name: 'SINK_DISCORD_SERVICE_STATUS_URL',
        value: DISCORD_URL,
      },
    ])
  })

  it('fails before editing when a write-only secret is unavailable locally', () => {
    expect(() => prepareSinkRename(ROUTES, '', 'discord', 'service')).toThrow(/missing from \.dev\.vars/)
  })

  it('leaves custom secret references unchanged', () => {
    const customRoutes = ROUTES.replace(', "discord-service-status"', '').replace('SINK_DISCORD_URL', 'CUSTOM_WEBHOOK')
    const prepared = prepareSinkRename(customRoutes, '', 'discord', 'service')
    const routes = parseRoutes(prepared.routesText)
    expect(routes.sinks.map((sink) => sink.urlEnv)).toEqual(['CUSTOM_WEBHOOK', 'CUSTOM_WEBHOOK'])
    expect(prepared.secrets).toEqual([])
  })
})

describe('switchSinkRename', () => {
  it('switches subscriptions without removing the old compatibility alias', () => {
    const prepared = prepareSinkRename(
      ROUTES.replace(', "discord-service-status"', ''),
      `SINK_DISCORD_URL=${DISCORD_URL}\n`,
      'discord',
      'discord-service-status',
    )
    const switched = switchSinkRename(prepared.routesText, 'discord', 'discord-service-status')
    const routes = parseRoutes(switched.routesText)

    expect(switched.subscriptions).toEqual(['status', 'combined'])
    expect(routes.subs.map((sub) => sub.sinks)).toEqual([
      ['discord-service-status'],
      ['discord-service-status'],
    ])
    expect(routes.sinks.map((sink) => sink.name)).toEqual(['discord', 'discord-service-status'])
  })

  it('refuses to switch through aliases with different destinations', () => {
    const mismatched = ROUTES.replace(
      '{ "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" }',
      '{ "name": "discord", "type": "discord", "urlEnv": "SINK_SERVICE_URL" },\n    { "name": "discord-service-status", "type": "discord", "urlEnv": "SINK_OTHER_URL" }',
    )
    expect(() => switchSinkRename(mismatched, 'discord', 'discord-service-status')).toThrow(/aliases differ/)
  })
})

describe('finalizeSinkRename', () => {
  it('removes the obsolete secret but retains both sink names on the new secret', () => {
    const prepared = prepareSinkRename(
      ROUTES.replace(', "discord-service-status"', ''),
      `SINK_DISCORD_URL=${DISCORD_URL}\n`,
      'discord',
      'discord-service-status',
    )
    const switched = switchSinkRename(prepared.routesText, 'discord', 'discord-service-status')
    const finalized = finalizeSinkRename(
      switched.routesText,
      prepared.devVarsText,
      'discord',
      'discord-service-status',
    )

    expect(finalized.devVarsText).not.toContain('SINK_DISCORD_URL=')
    expect(finalized.devVarsText).toContain('SINK_DISCORD_SERVICE_STATUS_URL=')
    expect(finalized.secretNames).toEqual([
      { oldName: 'SINK_DISCORD_URL', newName: 'SINK_DISCORD_SERVICE_STATUS_URL' },
    ])
    const routes = parseRoutes(switched.routesText)
    expect(routes.sinks).toHaveLength(2)
    expect(routes.sinks.every((sink) => sink.urlEnv === 'SINK_DISCORD_SERVICE_STATUS_URL')).toBe(true)
  })

  it('refuses to remove the old secret before subscription routing switches', () => {
    const prepared = prepareSinkRename(
      ROUTES.replace(', "discord-service-status"', ''),
      `SINK_DISCORD_URL=${DISCORD_URL}\n`,
      'discord',
      'discord-service-status',
    )
    expect(() => finalizeSinkRename(
      prepared.routesText,
      prepared.devVarsText,
      'discord',
      'discord-service-status',
    )).toThrow(/--switch phase/)
  })
})
