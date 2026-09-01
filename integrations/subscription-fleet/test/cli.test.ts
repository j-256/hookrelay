import { describe, expect, it } from 'vitest'
import { managedSubscriptionUsage, parseManagedSubscriptionArgs } from '../src/cli'

describe('managed subscription CLI', () => {
  it('requires a phase, private manifest, and explicit subscription', () => {
    expect(parseManagedSubscriptionArgs([
      'plan', '--manifest', '/secure/subscriptions.json', '--subscription', 'cloudflare-fleet',
    ])).toEqual({
      phase: 'plan',
      manifest: '/secure/subscriptions.json',
      subscriptions: ['cloudflare-fleet'],
      yes: false,
    })
    expect(() => parseManagedSubscriptionArgs(['plan', '--subscription', 'cloudflare-fleet']))
      .toThrow(/manifest/)
    expect(() => parseManagedSubscriptionArgs(['plan', '--manifest', '/secure/subscriptions.json']))
      .toThrow(/subscription/)
  })

  it('supports distinct repeatable selections and apply confirmation bypass', () => {
    expect(parseManagedSubscriptionArgs([
      'apply', '--manifest', '/secure/subscriptions.json',
      '--subscription', 'cloudflare-fleet', '--subscription', 'build-service', '-y',
    ])).toMatchObject({
      subscriptions: ['cloudflare-fleet', 'build-service'],
      yes: true,
    })
    expect(() => parseManagedSubscriptionArgs([
      'plan', '--manifest', '/secure/subscriptions.json',
      '--subscription', 'cloudflare-fleet', '--subscription', 'cloudflare-fleet',
    ])).toThrow(/supplied more than once/)
    expect(() => parseManagedSubscriptionArgs([
      'verify', '--manifest', '/secure/subscriptions.json', '--subscription', 'cloudflare-fleet', '-y',
    ])).toThrow(/only valid with apply/)
  })

  it('keeps short and long fleet options equivalent', () => {
    expect(parseManagedSubscriptionArgs([
      'apply', '-m', '/secure/subscriptions.json', '-s', 'cloudflare-fleet', '-y',
    ])).toEqual(parseManagedSubscriptionArgs([
      'apply', '--manifest', '/secure/subscriptions.json', '--subscription', 'cloudflare-fleet', '--yes',
    ]))
  })

  it('documents each phase and option', () => {
    const usage = managedSubscriptionUsage()
    expect(usage).toContain('<plan|prepare|apply|verify>')
    expect(usage).toContain('-m, --manifest')
    expect(usage).toContain('-s, --subscription')
  })
})
