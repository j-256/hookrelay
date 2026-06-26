import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getSink, listSinkTypes, registerSink } from '../../src/sinks'
import type { Sink } from '../../src/sinks'

const fake: Sink = {
  type: 'fake',
  configSchema: z.object({ note: z.string() }),
  async send() {
    /* no-op */
  },
}

describe('sink registry', () => {
  it('returns null for unknown sink types', () => {
    expect(getSink('does-not-exist')).toBeNull()
  })

  it('returns a registered sink by type', () => {
    registerSink(fake)
    expect(getSink('fake')).toBe(fake)
    expect(listSinkTypes()).toContain('fake')
  })

  it('rejects double-registration', () => {
    expect(() => registerSink(fake)).toThrow(/already registered/)
  })
})
