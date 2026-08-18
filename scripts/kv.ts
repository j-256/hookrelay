import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUBSCRIPTION_KEY_PREFIX } from '../src/lib/subscription'
import type { GitHubFleetProgress } from './github-fleet-model'
import { runProcess } from './setup'

type ProcessRunner = typeof runProcess

export interface RemoteKvSnapshot {
  subs: Record<string, string>
  sinks: Record<string, string>
}

interface RemoteKvBulkObjectEntry {
  value: unknown
}

const BULK_KEYS_FILE = 'keys.json'
const REMOTE_KV_BULK_GET_LIMIT = 100
const REMOTE_KV_BULK_READ_CONCURRENCY = 4

function parseRemoteKvBulkValues(binding: string, text: string, keys: readonly string[]): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`remote ${binding} bulk read returned invalid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`remote ${binding} bulk read returned an invalid result`)
  }
  const values = parsed as Record<string, string | RemoteKvBulkObjectEntry>
  const result: Record<string, string> = {}
  for (const key of keys) {
    const entry = values[key]
    if (typeof entry === 'string') {
      result[key] = entry
      continue
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.value !== 'string') {
      throw new Error(`remote ${binding} bulk read omitted one or more values`)
    }
    result[key] = entry.value
  }
  return result
}

async function bulkReadRemoteKv(
  binding: string,
  keys: readonly string[],
  runner: ProcessRunner,
): Promise<Record<string, string>> {
  if (keys.length === 0) return {}
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-kv-read-'))
  const result: Record<string, string> = {}
  try {
    const batches: string[][] = []
    for (let offset = 0; offset < keys.length; offset += REMOTE_KV_BULK_GET_LIMIT) {
      batches.push(keys.slice(offset, offset + REMOTE_KV_BULK_GET_LIMIT))
    }
    let nextBatch = 0
    const workers = Array.from(
      { length: Math.min(REMOTE_KV_BULK_READ_CONCURRENCY, batches.length) },
      async () => {
        while (nextBatch < batches.length) {
          const index = nextBatch
          nextBatch += 1
          const batch = batches[index]!
          const keysPath = join(directory, `${index}-${BULK_KEYS_FILE}`)
          await writeFile(keysPath, `${JSON.stringify(batch)}\n`, { mode: 0o600 })
          const output = await runner(
            'npx',
            ['wrangler', 'kv', 'bulk', 'get', keysPath, '--binding', binding, '--remote'],
            { captureStdout: true },
          )
          Object.assign(result, parseRemoteKvBulkValues(binding, output, batch))
        }
      },
    )
    await Promise.all(workers)
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function printableKvKey(key: string): string {
  if (key.startsWith('sub:') && !key.startsWith(SUBSCRIPTION_KEY_PREFIX)) {
    return 'sub:<legacy-redacted>'
  }
  return key
}

export async function listRemoteKv(
  binding: string,
  runner: ProcessRunner = runProcess,
  progress?: GitHubFleetProgress,
): Promise<Record<string, string>> {
  progress?.(`Listing remote ${binding} keys`)
  const keysOut = await runner(
    'npx',
    ['wrangler', 'kv', 'key', 'list', '--binding', binding, '--remote'],
    { captureStdout: true },
  )
  const keys = JSON.parse(keysOut) as Array<{ name: string }>
  const out: Record<string, string> = {}
  const readableKeys: string[] = []
  for (const { name } of keys) {
    if (binding === 'SUBS' && name.startsWith('sub:') && !name.startsWith(SUBSCRIPTION_KEY_PREFIX)) {
      out[name] = ''
      continue
    }
    readableKeys.push(name)
  }
  progress?.(`Reading remote ${binding} values in bulk 0/${keys.length}`)
  Object.assign(out, await bulkReadRemoteKv(binding, readableKeys, runner))
  progress?.(`Reading remote ${binding} values in bulk ${keys.length}/${keys.length}`)
  return out
}

export async function readRemoteKvSnapshot(
  runner: ProcessRunner = runProcess,
  progress?: GitHubFleetProgress,
): Promise<RemoteKvSnapshot> {
  return {
    subs: await listRemoteKv('SUBS', runner, progress),
    sinks: await listRemoteKv('SINKS', runner, progress),
  }
}

export async function putRemoteKv(
  binding: string,
  key: string,
  value: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  await runner('npx', ['wrangler', 'kv', 'key', 'put', key, value, '--binding', binding, '--remote'])
}

export async function deleteRemoteKv(
  binding: string,
  key: string,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  try {
    await runner('npx', ['wrangler', 'kv', 'key', 'delete', key, '--binding', binding, '--remote'])
  } catch {
    throw new Error(`KV delete failed for ${printableKvKey(key)} in ${binding}`)
  }
}
