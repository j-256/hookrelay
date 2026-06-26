import { describe, expect, it } from 'vitest'
import { getAdapter, registerAdapter, listSourceTypes } from '../../src/adapters'
import type { Adapter } from '../../src/adapters'

const fake: Adapter = {
  sourceType: 'fake',
  async verify() {},
  async parse() {
    return {
      source: 'fake',
      subName: 'x',
      type: 'noop',
      id: '1',
      timestamp: '2026-06-06T00:00:00.000Z',
      title: '',
      body: '',
      raw: null,
    }
  },
}

describe('adapter registry', () => {
  it('returns null for unknown source types', () => {
    expect(getAdapter('does-not-exist')).toBeNull()
  })

  it('returns a registered adapter by source type', () => {
    registerAdapter(fake)
    expect(getAdapter('fake')).toBe(fake)
    expect(listSourceTypes()).toContain('fake')
  })

  it('rejects double-registration of the same source type', () => {
    expect(() => registerAdapter(fake)).toThrow(/already registered/)
  })
})
