import { HANDOFF_LEGACY_MUTATION_ERROR, isHandoffSubscription } from '../../../src/lib/github-handoff'
import type { Routes } from '../../../scripts/sync'
import type { GitHubFleetManifest } from './manifest'

export function providerManagedRepositories(manifest: GitHubFleetManifest, routes: Routes): string[] {
  const names = new Map<string, string>()
  for (const [repository, entry] of Object.entries(manifest.repositories)) if (entry.provider) names.set(repository.toLowerCase(), repository)
  for (const sub of routes.subs) {
    if (!isHandoffSubscription(sub)) continue
    const repository = sub.githubHandoff?.repository ?? sub.setup?.github?.repo
    if (!repository) throw new Error('Provider-managed routing is missing repository ownership metadata')
    if (!names.has(repository.toLowerCase())) names.set(repository.toLowerCase(), repository)
  }
  return [...names.values()].sort()
}
export function assertLegacyFleetSelection(manifest: GitHubFleetManifest, routes: Routes, selected: readonly string[]): void {
  const managed = new Set(providerManagedRepositories(manifest, routes).map(name => name.toLowerCase()))
  if (selected.some(name => managed.has(name.toLowerCase()))) throw new Error(HANDOFF_LEGACY_MUTATION_ERROR)
}
