import type { Env } from '../index'

export function readSecret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`secret not set: ${name}`)
  }
  return value
}
