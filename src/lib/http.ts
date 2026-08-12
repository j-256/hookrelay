export interface PostOptions {
  headers?: Record<string, string>
  fetch?: typeof fetch
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

async function responseError(url: string, res: Response): Promise<HttpError> {
  const text = await res.text().catch(() => '')
  let host: string
  try { host = new URL(url).host } catch { host = '(invalid-url)' }
  return new HttpError(
    `POST ${host} -> ${res.status}: ${text.slice(0, 200)}`,
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
  })
  if (res.status >= 400) {
    throw await responseError(url, res)
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
  })
  if (res.status >= 400) {
    throw await responseError(url, res)
  }
  return res
}
