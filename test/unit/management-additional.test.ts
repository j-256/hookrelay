import { describe, expect, it } from 'vitest'
import type { Env } from '../../src/index'
import { authenticateManagement, assertCurrentManagementGrant, managementTokenHash } from '../../src/management/access'
const token = `hkr_${'a'.repeat(43)}`
const otherToken = `hkr_${'b'.repeat(43)}`
const request = (value: string) => new Request('https://example.test', { headers: { authorization: `Bearer ${value}` } })
async function credential(id: string, value: string) {
  return { id, revision: 1, tokenHash: await managementTokenHash(value), expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceIds: ['workspace'], capabilities: ['read', 'provision'] }
}
describe('additional management catalog', () => {
  it('preserves primary credentials while adding isolated identities and current-grant checks', async () => {
    const primary = await credential('primary', token)
    const additional = await credential('additional', otherToken)
    const env = { MANAGEMENT_CREDENTIALS: JSON.stringify([primary]), MANAGEMENT_CREDENTIALS_ADDITIONAL: JSON.stringify([additional]) } as Env
    expect((await authenticateManagement(request(token), env)).id).toBe('primary')
    const principal = await authenticateManagement(request(otherToken), env)
    expect(principal.id).toBe('additional')
    expect(() => assertCurrentManagementGrant(env, principal, 'workspace')).not.toThrow()
    env.MANAGEMENT_CREDENTIALS_ADDITIONAL = 'invalid'
    expect(() => assertCurrentManagementGrant(env, principal, 'workspace')).toThrow()
    expect((await authenticateManagement(request(token), env)).id).toBe('primary')
  })
  it('rejects shadowing ids or token hashes without disabling primary entries', async () => {
    const primary = await credential('primary', token)
    for (const additional of [{ ...await credential('primary', otherToken) }, { ...await credential('collision', token) }]) {
      const env = { MANAGEMENT_CREDENTIALS: JSON.stringify([primary]), MANAGEMENT_CREDENTIALS_ADDITIONAL: JSON.stringify([additional]) } as Env
      expect((await authenticateManagement(request(token), env)).id).toBe('primary')
      await expect(authenticateManagement(request(otherToken), env)).rejects.toThrow()
    }
  })
})
