import { describe, expect, it } from 'vitest'
import { normalizeHandoffRepository } from '../../src/lib/github-handoff'
import { openHandoffBundle, sealHandoffBundle } from '../../src/lib/github-handoff-crypto'
import { parseRoutes, computePlan } from '../../scripts/sync'

const environment = {
  HOOK_HANDOFF_KEYS: JSON.stringify({
    version: 1,
    activeKeyId: 'primary',
    keys: [{ id: 'primary', key: btoa('k'.repeat(32)) }],
  }),
}
const binding = {
  authorityId: 'a'.repeat(32),
  workspaceId: 'alpha',
  repositoryId: '2fdf499e-49af-4a22-b438-8abe1d2cf579',
  repository: 'Owner/Repo',
  revision: 1,
}
const bundle = {
  version: 1 as const,
  hmac: { name: 'HMAC_GITHUB_OWNER_REPO', value: 'synthetic-signing-value-only' },
  slugs: {
    activity: 'synthetic-activity-private-route',
    stars: 'synthetic-stars-private-route',
    alerts: 'synthetic-alerts-private-route',
  },
}

describe('manual GitHub repository identity', () => {
  it.each(['Owner/Repo', 'https://github.com/Owner/Repo', 'https://github.com/Owner/Repo/'])(
    'normalizes %s without losing display identity', (value) => {
      expect(normalizeHandoffRepository(value)).toEqual({ repository: 'Owner/Repo', key: 'owner/repo' })
    },
  )
  it.each([
    'http://github.com/Owner/Repo', 'https://github.com:443/Owner/Repo',
    'https://user@github.com/Owner/Repo', 'https://git.example/Owner/Repo',
    'https://github.com/Owner/Repo/issues', 'https://github.com/Owner/Repo?q=1',
    'https://github.com/Owner/Repo#readme', 'Owner/..', 'Owner/Repo/extra',
  ])('rejects ambiguous or out-of-scope repository input %s', (value) => {
    expect(() => normalizeHandoffRepository(value)).toThrow()
  })
  it('preserves a literal .git suffix', () => {
    expect(normalizeHandoffRepository('Owner/Repo.git').repository).toBe('Owner/Repo.git')
  })
})

describe('private repository credential custody', () => {
  it('encrypts recoverable values and restores them only for the bound repository', async () => {
    const sealed = await sealHandoffBundle(environment, binding, bundle)
    expect(JSON.stringify(sealed)).not.toContain(bundle.hmac.value)
    expect(JSON.stringify(sealed)).not.toContain(bundle.slugs.activity)
    await expect(openHandoffBundle(environment, binding, sealed)).resolves.toEqual(bundle)
    await expect(openHandoffBundle(environment, { ...binding, workspaceId: 'beta' }, sealed)).rejects.toThrow('unavailable')
    await expect(openHandoffBundle(environment, { ...binding, revision: 2 }, sealed)).rejects.toThrow('unavailable')
  })
  it('rejects tampered ciphertext and unavailable keyrings', async () => {
    const sealed = await sealHandoffBundle(environment, binding, bundle)
    const raw = Uint8Array.from(atob(sealed.ciphertext), (value) => value.charCodeAt(0))
    raw[0] = raw[0]! ^ 1
    await expect(openHandoffBundle(environment, binding, {
      ...sealed, ciphertext: btoa(String.fromCharCode(...raw)),
    })).rejects.toThrow('unavailable')
    await expect(openHandoffBundle({}, binding, sealed)).rejects.toThrow('unavailable')
  })
  it('uses fresh nonces without changing immutable credential values', async () => {
    const first = await sealHandoffBundle(environment, binding, bundle)
    const second = await sealHandoffBundle(environment, binding, bundle)
    expect(first.nonce).not.toBe(second.nonce)
    await expect(openHandoffBundle(environment, binding, second)).resolves.toEqual(bundle)
  })
})

describe('provider credential references in local route mirrors', () => {
  const subscription = {
    name: 'github:Owner/Repo', source: 'github', enabled: true, sinks: [], slugHash: 'a'.repeat(64),
    auth: { scheme: 'github-sha256', secretEnv: 'HOOK_HANDOFF_KEYS', credentialId: binding.repositoryId },
    githubHandoff: { ...binding, revision: undefined, profile: 'activity', resourceId: '52d5cc8e-5c91-48ed-8556-d83f086f3960' },
  }
  it('preserves bound authentication and ownership metadata through parsing and sync', () => {
    const routes = parseRoutes(JSON.stringify({ subs: [subscription], sinks: [] }))
    expect(routes.subs[0]!.auth).toEqual(subscription.auth)
    const plan = computePlan(routes, { subs: {}, sinks: {} })
    const runtime = JSON.parse(plan.subPuts[0]!.value)
    expect(runtime.auth.credentialId).toBe(binding.repositoryId)
    expect(runtime.githubHandoff.workspaceId).toBe('alpha')
    expect(runtime.githubHandoff.resourceId).toBe('52d5cc8e-5c91-48ed-8556-d83f086f3960')
  })
  it('rejects mixed credential references instead of stripping a private-store selector', () => {
    expect(() => parseRoutes(JSON.stringify({ subs: [{ ...subscription, auth: { ...subscription.auth, secretEnv: 'UNRELATED_SECRET' } }], sinks: [] }))).toThrow()
  })
})
