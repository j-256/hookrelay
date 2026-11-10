import { expect, it } from 'vitest'
import { githubAuthIdentity, githubAuthDescriptorSchema } from '../../src/lib/github-auth'
const descriptor = {
  id: 'provider-app',
  revision: 1,
  mode: 'app',
  appId: 42,
  installationId: 7,
  accountId: 50,
  keyRevision: 1,
  keySecretName: 'GITHUB_APP_KEY_A',
  fingerprint: 'a'.repeat(64),
  repositories: [{ id: 101, fullName: 'example/repository', ownerId: 50, private: true }],
  managementWorkspaces: ['alpha'],
  capabilities: ['repository-hooks-write'],
  state: 'active',
}
it('keeps stable identity separate from short-lived tokens and shares installation quota across workspaces', async () => {
  const active = githubAuthDescriptorSchema.parse(descriptor)
  const first = await githubAuthIdentity(
    active,
    1,
    'alpha',
    'caller',
    101,
    'repository-hooks-write',
  )
  const renewed = await githubAuthIdentity(
    active,
    1,
    'alpha',
    'caller',
    101,
    'repository-hooks-write',
  )
  const beta = await githubAuthIdentity(active, 1, 'beta', 'other', 101, 'repository-hooks-write')
  expect(renewed).toEqual(first)
  expect(beta.quotaKey).toBe(first.quotaKey)
  expect(beta.authorityIdentity).not.toBe(first.authorityIdentity)
  expect(
    (await githubAuthIdentity(active, 2, 'alpha', 'caller', 101, 'repository-hooks-write'))
      .authorityIdentity,
  ).not.toBe(first.authorityIdentity)
})
it('rejects raw credentials and ambiguous or empty App scopes in metadata', () => {
  for (const input of [
    { ...descriptor, privateKey: 'canary' },
    { ...descriptor, repositories: [] },
    { ...descriptor, mode: 'unknown' },
    { ...descriptor, managementWorkspaces: [] },
  ])
    expect(githubAuthDescriptorSchema.safeParse(input).success).toBe(false)
})
it('shares observed manual-token cooldown across descriptors that use the same credential', async () => {
  const { appId, installationId, accountId, keySecretName, ...common } = descriptor
  const first = githubAuthDescriptorSchema.parse({
    ...common,
    mode: 'token',
    tokenSecretName: 'GITHUB_MANUAL_A',
  })
  const second = githubAuthDescriptorSchema.parse({
    ...first,
    id: 'other-descriptor',
    managementWorkspaces: ['beta'],
  })
  expect(
    (await githubAuthIdentity(first, 1, 'alpha', 'caller', 101, 'repository-hooks-write')).quotaKey,
  ).toBe(
    (await githubAuthIdentity(second, 1, 'beta', 'other-caller', 101, 'repository-hooks-read'))
      .quotaKey,
  )
})
