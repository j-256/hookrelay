import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SUBSCRIPTION_SLUG_RE } from '../src/lib/subscription'
import {
  CLOUDEVENTS_CONTENT_TYPE,
  CLOUDEVENTS_SIGNATURE_HEADER,
} from '../src/adapters/cloudevents'
import {
  readSecret,
  runProcess,
  writePrivateText,
  type AtomicFileSystem,
} from './setup'

const CURL_COMMAND = 'curl'
const EVENT_SOURCE = 'urn:hookrelay:cloudevents-send'
const EVENT_TYPE = 'hookrelay.test'
const TEMP_DIRECTORY_PREFIX = 'hookrelay-cloudevent-'

export interface CloudEventsCredentials {
  hookUrl: string
  senderHmac: string
}

export interface CloudEventsSendDependencies {
  now(): Date
  randomId(): string
  readCredentials(): Promise<CloudEventsCredentials>
  runCurl(config: string): Promise<void>
  log(line: string): void
  fileSystem?: AtomicFileSystem
}

export interface CloudEventsSendResult {
  id: string
  type: string
}

const DEFAULT_DEPENDENCIES: CloudEventsSendDependencies = {
  now: () => new Date(),
  randomId: randomUUID,
  readCredentials: readCloudEventsCredentials,
  runCurl: runCurlConfig,
  log: console.log,
}

export function cloudEventsSendUsage(): string {
  return [
    'usage: pnpm cloudevents:send',
    '',
    'Sends one valid signed CloudEvents 1.0 test event through Hookrelay.',
    'The private Hookrelay URL and sender HMAC are read without echoing and',
    'are passed to curl through stdin rather than process arguments.',
    '',
    'Non-interactive stdin must contain the URL and HMAC on separate lines.',
    '',
    'options:',
    '  -h, --help  Show this help',
  ].join('\n')
}

export function parseCloudEventsCredentials(text: string): CloudEventsCredentials {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '')
  const lines = normalized.split('\n')
  if (lines.length !== 2 || !lines[0] || !lines[1]) {
    throw new Error('non-interactive input must contain the Hookrelay URL and sender HMAC on separate lines')
  }
  return { hookUrl: lines[0], senderHmac: lines[1] }
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function readCloudEventsCredentials(): Promise<CloudEventsCredentials> {
  if (!process.stdin.isTTY) return parseCloudEventsCredentials(await readStandardInput())
  const hookUrl = await readSecret('Private Hookrelay CloudEvents URL: ')
  const senderHmac = await readSecret('Sender HMAC: ')
  return { hookUrl, senderHmac }
}

export function normalizeCloudEventsHookUrl(value: string): string {
  if (value !== value.trim()) throw new Error('Hookrelay URL must not contain surrounding whitespace')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Hookrelay URL must be a valid URL')
  }
  if (url.protocol !== 'https:') throw new Error('Hookrelay URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Hookrelay URL contains unsupported components')
  }
  const segments = url.pathname.split('/')
  if (
    segments.length !== 4 ||
    segments[0] !== '' ||
    segments[1] !== 'hook' ||
    segments[2] !== 'cloudevents' ||
    !SUBSCRIPTION_SLUG_RE.test(segments[3]!)
  ) {
    throw new Error('Hookrelay URL must identify a CloudEvents subscription')
  }
  return url.toString()
}

export function createTestCloudEvent(id: string, time: Date): Record<string, unknown> {
  if (!id) throw new Error('CloudEvent ID must not be empty')
  return {
    specversion: '1.0',
    id,
    source: EVENT_SOURCE,
    type: EVENT_TYPE,
    time: time.toISOString(),
    subject: 'Hookrelay ingress test',
    severity: 'info',
    data: { message: 'Valid signed ingress test' },
  }
}

export function signCloudEvent(body: string, senderHmac: string): string {
  if (!senderHmac) throw new Error('sender HMAC must not be empty')
  return createHmac('sha256', senderHmac).update(body, 'utf8').digest('hex')
}

export function curlConfig(hookUrl: string, signature: string, bodyPath: string): string {
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('CloudEvent signature must be lowercase SHA-256')
  if (/[\r\n"]/u.test(hookUrl) || /[\r\n"]/u.test(bodyPath)) {
    throw new Error('curl configuration contains unsupported characters')
  }
  return [
    `url = "${hookUrl}"`,
    'request = "POST"',
    `header = "Content-Type: ${CLOUDEVENTS_CONTENT_TYPE}"`,
    `header = "${CLOUDEVENTS_SIGNATURE_HEADER}: sha256=${signature}"`,
    `data-binary = "@${bodyPath}"`,
    'fail-with-body',
    'silent',
    'show-error',
    'write-out = "\\nHTTP %{response_code}\\n"',
    '',
  ].join('\n')
}

export async function runCurlConfig(
  config: string,
  runner: typeof runProcess = runProcess,
): Promise<void> {
  await runner(CURL_COMMAND, ['--disable', '--config', '-'], { input: config })
}

export async function sendTestCloudEvent(
  dependencies: CloudEventsSendDependencies = DEFAULT_DEPENDENCIES,
): Promise<CloudEventsSendResult> {
  const credentials = await dependencies.readCredentials()
  const hookUrl = normalizeCloudEventsHookUrl(credentials.hookUrl)
  const id = dependencies.randomId()
  const body = JSON.stringify(createTestCloudEvent(id, dependencies.now()))
  const signature = signCloudEvent(body, credentials.senderHmac)
  const directory = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX))
  const bodyPath = join(directory, 'event.json')
  try {
    await writePrivateText(bodyPath, body, dependencies.fileSystem)
    await dependencies.runCurl(curlConfig(hookUrl, signature, bodyPath))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  dependencies.log(`Sent CloudEvent ${id} (${EVENT_TYPE})`)
  return { id, type: EVENT_TYPE }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(cloudEventsSendUsage())
    return
  }
  if (argv.length > 0) throw new Error(cloudEventsSendUsage())
  await sendTestCloudEvent()
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
