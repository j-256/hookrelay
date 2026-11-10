import { GitHubAuthError } from './github-app-contract'
export async function fetchGitHubWithDeadline(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  onDispatch?: () => void,
): Promise<Response> {
  if (new URL(url).origin !== 'https://api.github.com' || init.redirect !== 'manual')
    throw new GitHubAuthError('validation')
  if (init.signal.aborted) throw new GitHubAuthError('not_sent')
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new GitHubAuthError('unavailable'))
    init.signal.addEventListener('abort', abort, { once: true })
  })
  try {
    onDispatch?.()
    const pending = fetcher(url, init).then((response) => {
      if (init.signal.aborted) void response.body?.cancel().catch(() => {})
      return response
    })
    return await Promise.race([pending, aborted])
  } finally {
    if (abort) init.signal.removeEventListener('abort', abort)
  }
}
