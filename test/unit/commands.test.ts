import { describe, expect, it } from 'vitest'
import { commandReference } from '../../scripts/commands'
import { GITHUB_EVENT_PROFILES } from '../../scripts/providers/github/event-profiles'
import { KNOWN_SOURCE_TYPES } from '../../scripts/subscription-sources'

describe('commandReference', () => {
  it('lists routine commands and distinguishes production writes', () => {
    const reference = commandReference()

    expect(reference).toContain('pnpm sink:add <name> <discord|webhook>')
    expect(reference).toContain('pnpm sink:rename <old-name> <new-name>')
    expect(reference).toContain('pnpm sink:secret:rename <sink> <old-secret> <new-secret>')
    expect(reference).toContain('pnpm sub:add <name> <source> [-s <sink>]')
    expect(reference).toContain('--email-base, --allow-sender')
    expect(reference).toContain('pnpm github:events <name> [-e <profiles>]')
    expect(reference).not.toContain('sub:events')
    expect(reference).toContain('pnpm cloudevents:send')
    expect(reference).toContain('Optional integrations')
    expect(reference).toContain('pnpm github:fleet --help')
    expect(reference).toContain('integrations/github-fleet/README.md')
    expect(reference).toContain('pnpm sync\n')
    expect(reference).toContain('pnpm sync -y                         [production write]')
    expect(reference).toContain('npm version <major|minor|patch>')
    expect(reference).toContain('trigger a draft GitHub Release')
    expect(reference).toContain('GitHub Actions verifies the tag')
    expect(reference).toContain('pnpm retag --allow-published')
    expect(reference).toContain('pnpm deploy                          Deploy Worker code [production write]')
    expect(reference).toContain('Setup commands write local files before asking about production')
  })

  it('derives source and GitHub profile names from their registries', () => {
    const reference = commandReference()

    for (const source of KNOWN_SOURCE_TYPES) expect(reference).toContain(source)
    for (const profile of Object.keys(GITHUB_EVENT_PROFILES)) expect(reference).toContain(profile)
  })
})
