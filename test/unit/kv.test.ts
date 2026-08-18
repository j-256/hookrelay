import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { listRemoteKv, readRemoteKvSnapshot } from '../../scripts/kv'

const SUBSCRIPTION_KEY = `sub:sha256:${'a'.repeat(64)}`
const LEGACY_SUBSCRIPTION_KEY = 'sub:legacy-private-value'
const SINK_KEY = 'sink:discord:test'

describe('remote KV progress', () => {
  it('reports each remote read without exposing keys or values', async () => {
    const progress: string[] = []
    const runner = async (_command: string, args: string[]) => {
      const binding = args[args.indexOf('--binding') + 1]
      if (args[3] === 'list') {
        return JSON.stringify(binding === 'SUBS'
          ? [{ name: SUBSCRIPTION_KEY }, { name: LEGACY_SUBSCRIPTION_KEY }]
          : [{ name: SINK_KEY }])
      }
      const keys = JSON.parse(await readFile(args[4]!, 'utf8')) as string[]
      return JSON.stringify(Object.fromEntries(keys.map((key) => [
        key,
        binding === 'SUBS' ? 'private-subscription-value' : 'private-sink-value',
      ])))
    }

    const snapshot = await readRemoteKvSnapshot(runner, (message) => progress.push(message))
    expect(snapshot).toEqual({
      subs: {
        [LEGACY_SUBSCRIPTION_KEY]: '',
        [SUBSCRIPTION_KEY]: 'private-subscription-value',
      },
      sinks: { [SINK_KEY]: 'private-sink-value' },
    })
    expect(progress).toEqual([
      'Listing remote SUBS keys',
      'Reading remote SUBS values in bulk 0/2',
      'Reading remote SUBS values in bulk 2/2',
      'Listing remote SINKS keys',
      'Reading remote SINKS values in bulk 0/1',
      'Reading remote SINKS values in bulk 1/1',
    ])
    expect(progress.join('\n')).not.toContain(SUBSCRIPTION_KEY)
    expect(progress.join('\n')).not.toContain(LEGACY_SUBSCRIPTION_KEY)
    expect(progress.join('\n')).not.toContain(SINK_KEY)
    expect(progress.join('\n')).not.toContain('private-')
  })

  it('keeps bulk reads within the remote API limit', async () => {
    const keys = Array.from({ length: 101 }, (_, index) => `sink:test:${index}`)
    const batchSizes: number[] = []
    const runner = async (_command: string, args: string[]) => {
      if (args[3] === 'list') return JSON.stringify(keys.map((name) => ({ name })))
      const batch = JSON.parse(await readFile(args[4]!, 'utf8')) as string[]
      batchSizes.push(batch.length)
      return JSON.stringify(Object.fromEntries(batch.map((key) => [key, { value: `value:${key}` }])))
    }

    const values = await listRemoteKv('SINKS', runner)
    expect(batchSizes.sort((left, right) => left - right)).toEqual([1, 100])
    expect(Object.keys(values)).toHaveLength(keys.length)
  })
})
