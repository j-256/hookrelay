import { describe, expect, it } from 'vitest'
import { readRemoteKvSnapshot } from '../../scripts/kv'

const SUBSCRIPTION_KEY = `sub:sha256:${'a'.repeat(64)}`
const SINK_KEY = 'sink:discord:test'

describe('remote KV progress', () => {
  it('reports each remote read without exposing keys or values', async () => {
    const progress: string[] = []
    const runner = async (_command: string, args: string[]) => {
      const binding = args[args.indexOf('--binding') + 1]
      if (args[3] === 'list') {
        return JSON.stringify([{ name: binding === 'SUBS' ? SUBSCRIPTION_KEY : SINK_KEY }])
      }
      return binding === 'SUBS' ? 'private-subscription-value' : 'private-sink-value'
    }

    const snapshot = await readRemoteKvSnapshot(runner, (message) => progress.push(message))
    expect(snapshot).toEqual({
      subs: { [SUBSCRIPTION_KEY]: 'private-subscription-value' },
      sinks: { [SINK_KEY]: 'private-sink-value' },
    })
    expect(progress).toEqual([
      'Listing remote SUBS keys',
      'Reading remote SUBS value 1/1',
      'Listing remote SINKS keys',
      'Reading remote SINKS value 1/1',
    ])
    expect(progress.join('\n')).not.toContain(SUBSCRIPTION_KEY)
    expect(progress.join('\n')).not.toContain(SINK_KEY)
    expect(progress.join('\n')).not.toContain('private-')
  })
})
