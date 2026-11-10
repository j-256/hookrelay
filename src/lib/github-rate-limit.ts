import { GITHUB_APP_LIMITS } from './github-app-contract'
export function githubRetryAt(response: Response, now = Date.now()): number | null {
  const retry = response.headers.get('retry-after')
  if (
    response.status !== 429 &&
    !(
      response.status === 403 &&
      (retry !== null || response.headers.get('x-ratelimit-remaining') === '0')
    )
  )
    return null
  const seconds = retry !== null && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) : NaN
  const date = retry !== null && !Number.isFinite(seconds) ? Date.parse(retry) : NaN
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
  const requested = Number.isFinite(seconds)
    ? now + seconds * 1000
    : Number.isFinite(date)
      ? date
      : reset
  return Math.min(
    now + GITHUB_APP_LIMITS.COOLDOWN_MAX_MS,
    Math.max(
      now + GITHUB_APP_LIMITS.AUTHORITY_AGE_MS,
      Number.isFinite(requested) ? requested : now,
    ),
  )
}
