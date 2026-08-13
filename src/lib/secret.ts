import type { Env } from '../index'

export function readOptionalSecret(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readSecret(env: Env, name: string): string {
  const value = readOptionalSecret(env, name)
  if (value === undefined) throw new Error(`secret not set: ${name}`)
  return value
}
