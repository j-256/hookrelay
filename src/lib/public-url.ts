export function normalizeFallbackUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('fallback URL is invalid')
  }
  if (url.protocol !== 'https:') throw new Error('fallback URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('fallback URL must not contain credentials, a query, or a fragment')
  }
  return url.toString()
}
