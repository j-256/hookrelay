export interface PostOptions {
  headers?: Record<string, string>
  fetch?: typeof fetch
}

export async function postJson(url: string, body: unknown, opts: PostOptions = {}): Promise<Response> {
  const f = opts.fetch ?? fetch
  const res = await f(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
  })
  if (res.status >= 400) {
    const text = await res.text().catch(() => '')
    let host: string
    try { host = new URL(url).host } catch { host = '(invalid-url)' }
    throw new Error(`POST ${host} -> ${res.status}: ${text.slice(0, 200)}`)
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
  })
  if (res.status >= 400) {
    const text = await res.text().catch(() => '')
    let host: string
    try { host = new URL(url).host } catch { host = '(invalid-url)' }
    throw new Error(`POST ${host} -> ${res.status}: ${text.slice(0, 200)}`)
  }
  return res
}
