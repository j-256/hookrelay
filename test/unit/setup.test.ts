import { describe, expect, it } from 'vitest'
import { addDevVar, envSegment, getDevVar, removeDevVar } from '../../scripts/setup'

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

describe('.dev.vars lookup and removal', () => {
  it('parses generated, exported, and quoted values without exposing syntax', () => {
    const text = 'PLAIN=value\nexport EXPORTED = other\nQUOTED="value with spaces"\n'
    expect(getDevVar(text, 'PLAIN')).toBe('value')
    expect(getDevVar(text, 'EXPORTED')).toBe('other')
    expect(getDevVar(text, 'QUOTED')).toBe('value with spaces')
    expect(getDevVar(text, 'MISSING')).toBeNull()
  })

  it('removes exactly one assignment while preserving surrounding content', () => {
    const text = '# local secrets\nFIRST=one\nexport SECOND = "two words"\nTHIRD=three\n'
    expect(removeDevVar(text, 'SECOND')).toBe('# local secrets\nFIRST=one\nTHIRD=three\n')
    expect(() => removeDevVar(text, 'MISSING')).toThrow(/does not exist/)
  })
})
