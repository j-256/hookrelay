import { describe, expect, it } from 'vitest'
import { hashSubscriptionSlug } from '../../../src/lib/subscription'
import { parseGitHubFleetManifest, serializeGitHubFleetManifest } from '../src/manifest'
import { mergeHandoffRecovery, parseHandoffRecoveryEnvelope } from '../src/handoff-recovery'
import { prepareGitHubSubscriptionEvents } from '../../../scripts/providers/github/subscription-events'
import { planGitHubEventSync } from '../../../scripts/providers/github/sync-events'

const repositoryId = '2fdf499e-49af-4a22-b438-8abe1d2cf579'
const resourceId = '52d5cc8e-5c91-48ed-8556-d83f086f3960'
const record = {
  hmac: { name: 'HMAC_GITHUB_OWNER_REPO', value: 'synthetic-recovery-secret' },
  slugs: { activity: 'synthetic-recovery-activity-route', stars: 'synthetic-recovery-stars-route', alerts: 'synthetic-recovery-alerts-route' },
  profiles: ['activity'], state: 'active',
}
const binding = { kind: 'hookrelay-handoff-v1', authorityId: 'a'.repeat(32), workspaceId: 'alpha', repositoryId, bundleRevision: 1,
  resources: { activity: { resourceId, authMode: 'environment' } } }
async function envelope() {
  return { version: 1, repository: 'Owner/Repo', origin: 'https://hooks.example', exportedAt: '2026-11-05T00:00:00.000Z', record: { ...record, provider: binding }, routes: [{
    name: 'github:Owner/Repo', source: 'github', enabled: true, sinks: ['discord:repo-activity'], slugHash: await hashSubscriptionSlug(record.slugs.activity),
    auth: { scheme: 'github-sha256', secretEnv: record.hmac.name },
    githubHandoff: { authorityId: binding.authorityId, workspaceId: binding.workspaceId, repositoryId, resourceId, repository: 'Owner/Repo', profile: 'activity' },
    filter: { eventTypes: { include: ['push.created'] } }, setup: { github: { repo: 'Owner/Repo', eventProfiles: ['activity'] } },
  }] }
}
describe('provider-owned GitHub recovery', () => {
  it('preserves v5 provider bindings through manifest serialization', () => {
    const text = JSON.stringify({ version: 5, repositories: { 'Owner/Repo': { ...record, provider: binding } }, retiredRepositories: {} })
    const saved = parseGitHubFleetManifest(text)
    const reloaded = parseGitHubFleetManifest(serializeGitHubFleetManifest(saved))
    expect(reloaded.repositories['Owner/Repo']!.provider).toEqual(binding)
    expect(() => parseGitHubFleetManifest(text.replace('"version":5', '"version":4'))).toThrow(/version/)
  })
  it('adopts an identical unbound legacy recovery record without changing other repositories', async () => {
    const other = { hmac: { name: 'HMAC_GITHUB_OTHER_REPO', value: 'synthetic-other-secret' }, slugs: { activity: 'other-activity-private-route', stars: 'other-stars-private-route', alerts: 'other-alerts-private-route' }, state: 'active' }
    const before = JSON.stringify({ version: 4, repositories: { 'Owner/Repo': record, 'Other/Repo': other }, retiredRepositories: {} })
    const route = (await envelope()).routes[0]!
    const { githubHandoff: _provider, ...legacy } = route
    const routes = JSON.stringify({ baseUrl: 'https://hooks.example', subs: [legacy], sinks: [{ name: 'discord:repo-activity', type: 'discord', urlEnv: 'SYNTHETIC_DISCORD_URL' }] })
    const merged = await mergeHandoffRecovery(before, routes, await parseHandoffRecoveryEnvelope(JSON.stringify(await envelope())))
    const manifest = parseGitHubFleetManifest(merged.manifestText)
    expect(manifest.repositories['Owner/Repo']!.hmac).toEqual(record.hmac)
    expect(manifest.repositories['Owner/Repo']!.slugs).toEqual(record.slugs)
    expect(manifest.repositories['Other/Repo']).toEqual(other)
    expect(manifest.version).toBe(5)
    expect(JSON.parse(merged.routesText!).subs[0].filter).toEqual({ eventTypes: { include: ['push.created'] } })
    const again = await mergeHandoffRecovery(merged.manifestText, merged.routesText, await parseHandoffRecoveryEnvelope(JSON.stringify(await envelope())))
    expect(again.manifestText).toBe(merged.manifestText)
    expect(again.routesText).toBe(merged.routesText)
  })
  it('refuses a changed HMAC or provider binding instead of replacing recovery values', async () => {
    const source = await parseHandoffRecoveryEnvelope(JSON.stringify(await envelope()))
    const before = JSON.stringify({ version: 4, repositories: { 'Owner/Repo': { ...record, hmac: { ...record.hmac, value: 'another-synthetic-secret' } } }, retiredRepositories: {} })
    await expect(mergeHandoffRecovery(before, undefined, source)).rejects.toThrow(/conflict/i)
    const bound = JSON.stringify({ version: 5, repositories: { 'Owner/Repo': { ...record, provider: { ...binding, repositoryId: crypto.randomUUID() } } }, retiredRepositories: {} })
    await expect(mergeHandoffRecovery(bound, undefined, source)).rejects.toThrow(/conflict/i)
  })
  it('adds a bundle-backed profile while preserving the adopted activity binding', async () => {
    const before = await parseHandoffRecoveryEnvelope(JSON.stringify(await envelope()))
    const nextId = '896965f4-c06c-4d92-a24a-fd2d23699f81'
    const after = JSON.parse(JSON.stringify(await envelope()))
    after.record.profiles.push('stars')
    after.record.provider.resources.stars = { resourceId: nextId, authMode: 'bundle' }
    after.routes.push({ ...after.routes[0], name: 'github:Owner/Repo:stars', slugHash: await hashSubscriptionSlug(record.slugs.stars),
      auth: { scheme: 'github-sha256', secretEnv: 'HOOK_HANDOFF_KEYS', credentialId: repositoryId },
      githubHandoff: { ...after.routes[0].githubHandoff, resourceId: nextId, profile: 'stars' }, setup: { github: { repo: 'Owner/Repo', eventProfiles: ['stars'] } } })
    const original = JSON.stringify({ version: 5, repositories: { 'Owner/Repo': before.record }, retiredRepositories: {} })
    const merged = await mergeHandoffRecovery(original, undefined, await parseHandoffRecoveryEnvelope(JSON.stringify(after)))
    const saved = parseGitHubFleetManifest(merged.manifestText).repositories['Owner/Repo']!
    expect(saved.provider!.resources.activity).toEqual(binding.resources.activity)
    expect(saved.provider!.resources.stars).toEqual({ resourceId: nextId, authMode: 'bundle' })
    expect(saved.hmac).toEqual(record.hmac)
    expect(saved.slugs).toEqual(record.slugs)
  })
  it('rejects route-hash or workspace mismatches inside a private export', async () => {
    const source = await envelope()
    source.routes[0]!.slugHash = 'b'.repeat(64)
    await expect(parseHandoffRecoveryEnvelope(JSON.stringify(source))).rejects.toThrow(/recovery/i)
    const other = await envelope()
    other.routes[0]!.githubHandoff.workspaceId = 'beta'
    await expect(parseHandoffRecoveryEnvelope(JSON.stringify(other))).rejects.toThrow(/recovery/i)
  })
  it('refuses a legacy event edit before changing provider-owned local routing', async () => {
    const source = await envelope()
    const routes = JSON.stringify({ subs: source.routes, sinks: [] })
    expect(() => prepareGitHubSubscriptionEvents(routes, 'github:Owner/Repo')).toThrow(/provider-managed/i)
  })
  it('excludes provider-managed receivers from bulk legacy event synchronization', async () => {
    const source = await envelope()
    let reads = 0
    const plan = await planGitHubEventSync(JSON.stringify({ subs: source.routes, sinks: [] }), '', async () => { reads++; throw new Error('Unexpected upstream administrator read') })
    expect(reads).toBe(0)
    expect(plan.checked).toBe(0)
    expect(plan.providerScope.puts).toEqual([])
    expect(plan.providerManaged).toEqual(['github:Owner/Repo'])
  })
})
