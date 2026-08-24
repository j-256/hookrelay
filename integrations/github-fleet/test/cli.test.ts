import { describe, expect, it } from 'vitest'
import { githubFleetUsage, parseGitHubFleetArgs } from '../src/cli'

const REPO = 'example-owner/example-plugin'
const OTHER_REPO = 'example-owner/example-repo'

describe('GitHub fleet CLI', () => {
  it('requires an explicit phase, root, and manifest', () => {
    expect(parseGitHubFleetArgs(['plan', '--root', '/repo', '--manifest', '/secure/fleet.json'])).toMatchObject({
      phase: 'plan',
      roots: ['/repo'],
      manifest: '/secure/fleet.json',
      includePrivate: false,
      secretLimit: 64,
    })
    expect(() => parseGitHubFleetArgs(['plan', '--root', '/repo'])).toThrow(/manifest/)
    expect(() => parseGitHubFleetArgs(['prepare', '--root', '/repo', '--manifest', 'fleet.json', '-y'])).toThrow(/only valid/)
  })

  it('accepts distinct repeatable checkout roots', () => {
    expect(parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--root', '/repo/3p', '--manifest', 'fleet.json',
    ])).toMatchObject({ roots: ['/repo', '/repo/3p'] })
    expect(() => parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--root', '/repo', '--manifest', 'fleet.json',
    ])).toThrow(/supplied more than once/)
  })

  it('accepts repeatable repository filters and a capacity override', () => {
    expect(parseGitHubFleetArgs([
      'apply', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--repo', OTHER_REPO,
      '--secret-limit', '80', '-y',
    ])).toMatchObject({ repositories: [REPO, OTHER_REPO], secretLimit: 80, yes: true })
  })

  it('accepts a profile subset only with explicit repository selectors', () => {
    expect(parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--profiles', 'alerts',
    ])).toMatchObject({ repositories: [REPO], profiles: ['alerts'] })
    expect(() => parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--profiles', 'alerts',
    ])).toThrow(/requires at least one --repo/)
    expect(() => parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--profiles', 'alerts', '--retire',
    ])).toThrow(/cannot be combined/)
  })

  it('requires repository selectors when private discovery is enabled', () => {
    expect(parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--include-private',
    ])).toMatchObject({ repositories: [REPO], includePrivate: true })
    expect(() => parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--manifest', 'fleet.json', '--include-private',
    ])).toThrow(/requires at least one --repo/)
  })

  it('requires explicit repository selectors for retirement', () => {
    expect(parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--retire',
    ])).toMatchObject({ repositories: [REPO], retire: true })
    expect(() => parseGitHubFleetArgs([
      'plan', '--root', '/repo', '--manifest', 'fleet.json', '--retire',
    ])).toThrow(/requires at least one --repo/)
  })

  it('requires explicit repository selectors for HMAC rotation', () => {
    expect(parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--rotate-hmac',
    ])).toMatchObject({ repositories: [REPO], rotateHmac: true })
    expect(() => parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--rotate-hmac',
    ])).toThrow(/requires at least one --repo/)
    expect(() => parseGitHubFleetArgs([
      'prepare', '--root', '/repo', '--manifest', 'fleet.json', '--repo', REPO, '--retire', '--rotate-hmac',
    ])).toThrow(/cannot be combined/)
  })

  it('documents every phase and option', () => {
    const usage = githubFleetUsage()
    expect(usage).toContain('<plan|prepare|apply|verify>')
    expect(usage).toContain('--root')
    expect(usage).toContain('--profiles')
    expect(usage).toContain('--include-private')
    expect(usage).toContain('--retire')
    expect(usage).toContain('--rotate-hmac')
  })
})
