import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import type { Sub } from '../../../scripts/sync'

const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function authNames(subscription: Sub): string[] {
  if (!subscription.auth) return []
  return [subscription.auth.secretEnv, ...(subscription.auth.alternateSecretEnvs ?? [])]
}

export function managedRouteIdentityIssues(existing: Sub, desired: Sub): string[] {
  const issues: string[] = []
  if (existing.source !== desired.source) issues.push('source')
  if (existing.slugHash !== desired.slugHash) issues.push('slug hash')
  if (existing.auth?.scheme !== desired.auth?.scheme) issues.push('authentication scheme')
  if (canonical(authNames(existing)) !== canonical(authNames(desired))) issues.push('authentication references')
  return issues
}

export function managedRouteMatches(existing: Sub, desired: Sub): boolean {
  return canonical(existing) === canonical(desired)
}

export interface ManagedRouteUpdate {
  routesText: string
  additions: string[]
  updates: string[]
}

export function updateManagedRoutes(
  routesText: string,
  existingSubscriptions: readonly Sub[],
  desiredSubscriptions: ReadonlyMap<string, Sub>,
): ManagedRouteUpdate {
  let updated = routesText
  const additions: string[] = []
  const updates: string[] = []
  const working = [...existingSubscriptions]

  for (const [name, desired] of [...desiredSubscriptions].sort(([left], [right]) => left.localeCompare(right))) {
    const matchingIndexes = working.flatMap((subscription, index) => subscription.name === name ? [index] : [])
    if (matchingIndexes.length > 1) throw new Error(`subscription is declared more than once: ${name}`)
    const hashOwner = working.find((subscription) => (
      subscription.slugHash === desired.slugHash && subscription.name !== name
    ))
    if (hashOwner) throw new Error(`${name}: slug hash is already owned by ${hashOwner.name}`)
    const secretOwner = working.find((subscription) => (
      subscription.name !== name && authNames(subscription).includes(desired.auth!.secretEnv)
    ))
    if (secretOwner) throw new Error(`${name}: HMAC reference is already used by ${secretOwner.name}`)

    if (matchingIndexes.length === 0) {
      updated = applyEdits(updated, modify(updated, ['subs', -1], desired, {
        formattingOptions: FORMATTING_OPTIONS,
      }))
      working.push(desired)
      additions.push(name)
      continue
    }

    const index = matchingIndexes[0]!
    const existing = working[index]!
    const identityIssues = managedRouteIdentityIssues(existing, desired)
    if (identityIssues.length > 0) {
      throw new Error(`${name}: route identity differs (${identityIssues.join(', ')})`)
    }
    if (managedRouteMatches(existing, desired)) continue
    updated = applyEdits(updated, modify(updated, ['subs', index], desired, {
      formattingOptions: FORMATTING_OPTIONS,
    }))
    working[index] = desired
    updates.push(name)
  }

  return { routesText: updated, additions, updates }
}
