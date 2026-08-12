import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com'
const WRANGLER_CONFIG_FILE = 'wrangler.jsonc'

export interface WorkerDomainRecord {
  hostname: string
  service: string
  environment?: string
  enabled?: boolean
}

interface CloudflareDomainResponse {
  success?: boolean
  errors?: Array<{ message?: string }>
  result?: WorkerDomainRecord[]
}

interface DiscoveryOptions {
  accountId?: string
  apiToken?: string
  configText?: string
  fetchFn?: typeof fetch
}

export function workerNameFromWrangler(text: string): string {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null) {
    throw new Error('cannot discover base URL: wrangler.jsonc is invalid; pass --base-url')
  }
  const name = (parsed as Record<string, unknown>).name
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('cannot discover base URL: wrangler.jsonc has no Worker name; pass --base-url')
  }
  return name
}

export function selectWorkerBaseUrl(records: WorkerDomainRecord[], workerName: string): string {
  const hostnames = [...new Set(
    records
      .filter((record) => (
        record.service === workerName &&
        (record.environment === undefined || record.environment === 'production') &&
        record.enabled !== false &&
        record.hostname.length > 0
      ))
      .map((record) => record.hostname.toLowerCase()),
  )].sort()

  if (hostnames.length === 0) {
    throw new Error(`cannot discover base URL: Worker ${workerName} has no production custom domain; pass --base-url`)
  }
  if (hostnames.length > 1) {
    throw new Error(
      `cannot choose a base URL: Worker ${workerName} has multiple custom domains (${hostnames.join(', ')}); pass --base-url`,
    )
  }
  return `https://${hostnames[0]}`
}

function cloudflareError(body: CloudflareDomainResponse, status: number): Error {
  const details = body.errors
    ?.map((error) => error.message)
    .filter((message): message is string => Boolean(message))
    .join('; ')
  const suffix = details ? `: ${details}` : ''
  return new Error(`cannot discover base URL: Cloudflare domains request failed (${status})${suffix}; pass --base-url`)
}

export async function discoverWorkerBaseUrl(options: DiscoveryOptions = {}): Promise<string> {
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID
  const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    throw new Error(
      'cannot discover base URL: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required; pass --base-url',
    )
  }

  let configText = options.configText
  if (configText === undefined) {
    try {
      configText = await readFile(resolve(WRANGLER_CONFIG_FILE), 'utf8')
    } catch {
      throw new Error('cannot discover base URL: wrangler.jsonc could not be read; pass --base-url')
    }
  }
  const workerName = workerNameFromWrangler(configText)
  const url = new URL(
    `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/domains`,
    CLOUDFLARE_API_ORIGIN,
  )
  url.searchParams.set('service', workerName)
  url.searchParams.set('environment', 'production')

  let response: Response
  try {
    response = await (options.fetchFn ?? fetch)(url, {
      headers: { authorization: `Bearer ${apiToken}` },
    })
  } catch {
    throw new Error('cannot discover base URL: Cloudflare domains request failed; pass --base-url')
  }
  let body: CloudflareDomainResponse
  try {
    body = await response.json() as CloudflareDomainResponse
  } catch {
    throw cloudflareError({}, response.status)
  }
  if (!response.ok || body.success !== true || !Array.isArray(body.result)) {
    throw cloudflareError(body, response.status)
  }
  return selectWorkerBaseUrl(body.result, workerName)
}
