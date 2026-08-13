import { describe, expect, it } from 'vitest'
import { commandReference } from '../../scripts/commands'
import { GITHUB_EVENT_PROFILES } from '../../scripts/github-events'
import { KNOWN_SOURCE_TYPES } from '../../scripts/subscription-sources'

describe('commandReference', () => {
  it('lists routine commands and distinguishes production writes', () => {
    const reference = commandReference()

    expect(reference).toContain('pnpm sink:add <name> discord')
    expect(reference).toContain('pnpm sink:rename <old-name> <new-name>')
    expect(reference).toContain('pnpm sink:secret:rename <sink> <old-secret> <new-secret>')
    expect(reference).toContain('pnpm sub:add <name> <source> [-s <sink>]')
    expect(reference).toContain('pnpm sub:events <name> [-e <profiles>]')
    expect(reference).toContain('pnpm github:fleet plan --root <directory> --manifest <file>')
    expect(reference).toContain('pnpm github:fleet prepare --root <directory> --manifest <file>')
    expect(reference).toContain('pnpm github:fleet apply --root <directory> --manifest <file> [production write]')
    expect(reference).toContain('pnpm github:fleet verify --root <directory> --manifest <file>')
    expect(reference).toContain('fresh nondelivering GitHub pings')
    expect(reference).toContain('pnpm sync\n')
    expect(reference).toContain('pnpm sync -y                         [production write]')
    expect(reference).toContain('pnpm deploy                          Deploy Worker code [production write]')
    expect(reference).toContain('Setup commands write local files before asking about production')
  })

  it('derives source and GitHub profile names from their registries', () => {
    const reference = commandReference()

    for (const source of KNOWN_SOURCE_TYPES) expect(reference).toContain(source)
    for (const profile of Object.keys(GITHUB_EVENT_PROFILES)) expect(reference).toContain(profile)
  })
})
