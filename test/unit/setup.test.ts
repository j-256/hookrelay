import { describe, expect, it } from 'vitest'
import { addDevVar, envSegment } from '../../scripts/setup'

describe('envSegment', () => {
  it('normalizes config names into secret-name segments', () => {
    expect(envSegment('github-example-owner-example-repo')).toBe('GITHUB_EXAMPLE_OWNER_EXAMPLE_REPO')
    expect(envSegment('Personal alerts')).toBe('PERSONAL_ALERTS')
  })

  it('rejects names without letters or numbers', () => {
    expect(() => envSegment('---')).toThrow(/letter or number/)
  })
})

describe('addDevVar', () => {
  it('appends a variable with one trailing newline', () => {
    expect(addDevVar('FIRST=value\n', 'SECOND', 'secret')).toBe('FIRST=value\nSECOND=secret\n')
  })

  it('refuses to replace an existing variable', () => {
    expect(() => addDevVar('export SECOND=old\n', 'SECOND', 'new')).toThrow(/already exists/)
  })
})
