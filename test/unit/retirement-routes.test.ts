import { describe, expect, it } from 'vitest'
import {
  disableSubscription,
  removeRetiredSink,
  removeSubscription,
  retireSink,
} from '../../scripts/retirement-routes'
import { parseRoutes } from '../../scripts/sync'

const HASH = 'a'.repeat(64)

function routes(enabled: boolean): string {
  return `${JSON.stringify({
    subs: [{
      name: 'subscription',
      source: 'statuspage',
      slugHash: HASH,
      enabled,
      sinks: ['delivery'],
    }],
    sinks: [{ name: 'delivery', type: 'discord', urlEnv: 'SINK_DELIVERY_URL' }],
  }, null, 2)}\n`
}

describe('retirement route transforms', () => {
  it('disables and removes one exact subscription idempotently', () => {
    const first = disableSubscription(routes(true), 'subscription')
    expect(first.changed).toBe(true)
    expect(parseRoutes(first.routesText).subs[0]?.enabled).toBe(false)
    expect(disableSubscription(first.routesText, 'subscription').changed).toBe(false)
    expect(parseRoutes(removeSubscription(first.routesText, 'subscription').routesText).subs).toEqual([])
  })

  it('moves an unreferenced active sink to retiredSinks and later removes it', () => {
    const disabled = disableSubscription(routes(true), 'subscription').routesText
    const staged = retireSink(disabled, 'delivery')
    const parsed = parseRoutes(staged.routesText)
    expect(parsed.sinks).toEqual([])
    expect(parsed.retiredSinks).toEqual([{ name: 'delivery', type: 'discord', urlEnv: 'SINK_DELIVERY_URL' }])
    expect(retireSink(staged.routesText, 'delivery').changed).toBe(false)
    expect(parseRoutes(removeRetiredSink(staged.routesText, 'delivery').routesText).retiredSinks).toEqual([])
  })

  it('blocks staging while an enabled subscription or operations alert references the sink', () => {
    expect(() => retireSink(routes(true), 'delivery')).toThrow(/enabled subscriptions/)
    const withOperations = routes(false).replace(
      '  "subs":',
      '  "operations": { "sinks": ["delivery"], "alertCooldownMinutes": 60, "staleDeliveryMinutes": 15 },\n  "subs":',
    )
    expect(() => retireSink(withOperations, 'delivery')).toThrow(/operations alerting/)
  })
})
