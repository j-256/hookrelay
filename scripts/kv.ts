import { SUBSCRIPTION_KEY_PREFIX } from '../src/lib/subscription'
import { runProcess } from './setup'

type ProcessRunner = typeof runProcess

export interface RemoteKvSnapshot {
  subs: Record<string, string>
  sinks: Record<string, string>
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
): Promise<Record<string, string>> {
  const keysOut = await runner(
    'npx',
    ['wrangler', 'kv', 'key', 'list', '--binding', binding, '--remote'],
    { captureStdout: true },
  )
  const keys = JSON.parse(keysOut) as Array<{ name: string }>
  const out: Record<string, string> = {}
  for (const { name } of keys) {
    if (binding === 'SUBS' && name.startsWith('sub:') && !name.startsWith(SUBSCRIPTION_KEY_PREFIX)) {
      out[name] = ''
      continue
    }
    out[name] = await runner(
      'npx',
      ['wrangler', 'kv', 'key', 'get', name, '--binding', binding, '--text', '--remote'],
      { captureStdout: true },
    )
  }
  return out
}

export async function readRemoteKvSnapshot(runner: ProcessRunner = runProcess): Promise<RemoteKvSnapshot> {
  return {
    subs: await listRemoteKv('SUBS', runner),
    sinks: await listRemoteKv('SINKS', runner),
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
