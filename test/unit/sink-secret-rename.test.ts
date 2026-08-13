import { describe, expect, it } from 'vitest'
import {
  finalizeSinkSecretRename,
  parseSinkSecretRenameArgs,
  prepareSinkSecretRename,
  sinkSecretRenameUsage,
} from '../../scripts/sink-secret-rename'
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
    }
  ],
  "sinks": [
    { "name": "discord", "type": "discord", "urlEnv": "SINK_DISCORD_URL" },
    { "name": "other", "type": "discord", "urlEnv": "SINK_OTHER_URL" }
  ]
}
`

describe('parseSinkSecretRenameArgs', () => {
  it('uses prepare by default and accepts explicit finalization', () => {
    expect(parseSinkSecretRenameArgs([
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    ])).toEqual({
      sinkName: 'discord',
      oldSecretName: 'SINK_DISCORD_URL',
      newSecretName: 'SINK_DISCORD_SERVICE_STATUS_URL',
      phase: 'prepare',
      yes: false,
    })
    expect(parseSinkSecretRenameArgs([
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
      '--finalize',
      '-y',
    ])).toMatchObject({ phase: 'finalize', yes: true })
  })

  it('rejects invalid or conflicting arguments', () => {
    expect(() => parseSinkSecretRenameArgs(['discord', 'OLD', 'NEW', '--prepare', '--finalize'])).toThrow(/only one/)
    expect(() => parseSinkSecretRenameArgs(['discord', 'SAME', 'SAME'])).toThrow(/must differ/)
    expect(() => parseSinkSecretRenameArgs(['discord', 'OLD-NAME', 'NEW'])).toThrow(/invalid secret name/)
    expect(() => parseSinkSecretRenameArgs(['discord', 'OLD', 'NEW', '-x'])).toThrow(/unknown option/)
    expect(sinkSecretRenameUsage()).toContain('--finalize')
  })
})

describe('prepareSinkSecretRename', () => {
  it('changes only the selected sink reference while preserving its delivery identity', () => {
    const prepared = prepareSinkSecretRename(
      ROUTES,
      `SINK_DISCORD_URL=${DISCORD_URL}\nSINK_OTHER_URL=other\n`,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )
    const routes = parseRoutes(prepared.routesText)

    expect(prepared.routesText).toContain('// Preserve this routes comment')
    expect(routes.sinks).toEqual([
      { name: 'discord', type: 'discord', urlEnv: 'SINK_DISCORD_SERVICE_STATUS_URL' },
      { name: 'other', type: 'discord', urlEnv: 'SINK_OTHER_URL' },
    ])
    expect(routes.subs[0]!.sinks).toEqual(['discord'])
    expect(prepared.fieldName).toBe('urlEnv')
    expect(prepared.devVarsText).toContain(`SINK_DISCORD_URL=${DISCORD_URL}\n`)
    expect(prepared.devVarsText).toContain(`SINK_DISCORD_SERVICE_STATUS_URL=${DISCORD_URL}\n`)
    expect(prepared.secret).toEqual({
      name: 'SINK_DISCORD_SERVICE_STATUS_URL',
      value: DISCORD_URL,
    })
  })

  it('fails before editing when the old write-only secret is unavailable locally', () => {
    expect(() => prepareSinkSecretRename(
      ROUTES,
      '',
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )).toThrow(/missing from \.dev\.vars/)
  })

  it('refuses a new secret name that is already used', () => {
    expect(() => prepareSinkSecretRename(
      ROUTES,
      `SINK_DISCORD_URL=${DISCORD_URL}\nSINK_OTHER_URL=other\n`,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_OTHER_URL',
    )).toThrow(/already referenced/)
  })
})

describe('finalizeSinkSecretRename', () => {
  it('removes the old local secret after the route uses the new one', () => {
    const prepared = prepareSinkSecretRename(
      ROUTES,
      `SINK_DISCORD_URL=${DISCORD_URL}\nSINK_OTHER_URL=other\n`,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )
    const finalized = finalizeSinkSecretRename(
      prepared.routesText,
      prepared.devVarsText,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )

    expect(finalized.fieldName).toBe('urlEnv')
    expect(finalized.removedLocalSecret).toBe(true)
    expect(finalized.devVarsText).not.toContain('SINK_DISCORD_URL=')
    expect(finalized.devVarsText).toContain('SINK_DISCORD_SERVICE_STATUS_URL=')
  })

  it('refuses deletion while another route still uses the old secret', () => {
    const sharedRoutes = ROUTES.replace('SINK_OTHER_URL', 'SINK_DISCORD_URL')
    const prepared = prepareSinkSecretRename(
      sharedRoutes,
      `SINK_DISCORD_URL=${DISCORD_URL}\n`,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )
    expect(() => finalizeSinkSecretRename(
      prepared.routesText,
      prepared.devVarsText,
      'discord',
      'SINK_DISCORD_URL',
      'SINK_DISCORD_SERVICE_STATUS_URL',
    )).toThrow(/routes still reference/)
  })
})
