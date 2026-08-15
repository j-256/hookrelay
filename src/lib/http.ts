export interface PostOptions {
  headers?: Record<string, string>
  fetch?: typeof fetch
  redirect?: 'follow' | 'error' | 'manual'
  errorLabel?: string
  includeResponseBody?: boolean
}

const REQUEST_TIMEOUT_MS = 15_000

export class HttpError extends Error {
  readonly status: number
  readonly retryAfterSeconds?: number

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function retryAfterSeconds(res: Response): number | undefined {
  const value = res.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

async function responseError(url: string, res: Response, opts: PostOptions): Promise<HttpError> {
  const text = opts.includeResponseBody === false ? '' : await res.text().catch(() => '')
  let host: string
  try { host = new URL(url).host } catch { host = '(invalid-url)' }
  const target = opts.errorLabel ?? `POST ${host}`
  const suffix = text ? `: ${text.slice(0, 200)}` : ''
  return new HttpError(
    `${target} -> ${res.status}${suffix}`,
    res.status,
    retryAfterSeconds(res),
  )
}

export async function postJson(url: string, body: unknown, opts: PostOptions = {}): Promise<Response> {
  const f = opts.fetch ?? fetch
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: opts.redirect,
  })
  if (res.status < 200 || res.status >= 300) {
    throw await responseError(url, res, opts)
  }
  return res
}

export async function postRaw(
  url: string,
  body: BodyInit,
  opts: PostOptions = {},
): Promise<Response> {
  const f = opts.fetch ?? fetch
  const res = await f(url, {
    method: 'POST',
    headers: { ...(opts.headers ?? {}) },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: opts.redirect,
  })
  if (res.status < 200 || res.status >= 300) {
    throw await responseError(url, res, opts)
  }
  return res
}
