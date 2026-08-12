export const SUBSCRIPTION_SLUG_PATTERN = '[A-Za-z0-9_-]{22,}'
export const SUBSCRIPTION_SLUG_RE = new RegExp(`^${SUBSCRIPTION_SLUG_PATTERN}$`)
export const SUBSCRIPTION_HASH_RE = /^[a-f0-9]{64}$/
export const SUBSCRIPTION_KEY_PREFIX = 'sub:sha256:'

export async function hashSubscriptionSlug(slug: string): Promise<string> {
  if (!SUBSCRIPTION_SLUG_RE.test(slug)) throw new Error('invalid subscription slug')
  const bytes = new TextEncoder().encode(slug)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function subscriptionKvKey(slugHash: string): string {
  if (!SUBSCRIPTION_HASH_RE.test(slugHash)) throw new Error('invalid subscription slug hash')
  return `${SUBSCRIPTION_KEY_PREFIX}${slugHash}`
}

export async function subscriptionKvKeyForSlug(slug: string): Promise<string> {
  return subscriptionKvKey(await hashSubscriptionSlug(slug))
}
