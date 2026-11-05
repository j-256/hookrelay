import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseRecoveryArgs, runRecovery } from '../src/handoff-recovery-cli.ts'
import { hashSubscriptionSlug } from '../../../src/lib/subscription.ts'

test('recovery CLI supports equivalent option grammar and rejects unsafe inputs', () => {
  assert.deepEqual(parseRecoveryArgs(['-h']), { help: true })
  assert.deepEqual(parseRecoveryArgs(['--help']), { help: true })
  assert.deepEqual(parseRecoveryArgs(['import', '-yiinput.json', '-mmanifest.json']), parseRecoveryArgs(['--input=input.json', 'import', '--manifest', 'manifest.json', '--yes']))
  assert.equal(parseRecoveryArgs(['-i', 'input.json', '-m', 'manifest.json', '--', 'inspect']).command, 'inspect')
  for (const args of [['import', '-i', 'in', '-m', 'out'], ['inspect', '--input=', '-m', 'out'], ['inspect', '-i', 'in', '-m', 'out', '--secret', 'value'], ['inspect', '-i', 'in', '-i', 'in', '-m', 'out']]) assert.throws(() => parseRecoveryArgs(args), /arguments/)
})
test('recovery CLI refuses unsafe files without disclosing contents or writing recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-recovery-cli-'))
  try {
    const input = join(root, 'input.json')
    const manifest = join(root, 'manifest.json')
    const sentinel = 'synthetic-private-input-never-diagnostic'
    await writeFile(input, sentinel, { mode: 0o644 })
    await writeFile(manifest, '{"version":4,"repositories":{},"retiredRepositories":{}}', { mode: 0o600 })
    const before = await readFile(manifest, 'utf8')
    await assert.rejects(runRecovery(['import', '-i', input, '-m', manifest, '-y']), /validate failed/)
    await chmod(input, 0o600)
    await assert.rejects(runRecovery(['import', '-i', input, '-m', manifest, '-y']), error => !error.message.includes(sentinel))
    const link = join(root, 'link.json')
    await symlink(input, link)
    await assert.rejects(runRecovery(['inspect', '-i', link, '-m', manifest]), /validate failed/)
    assert.equal(await readFile(manifest, 'utf8'), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('recovery CLI imports a complete private envelope and safely repeats the same mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-recovery-import-'))
  try {
    const input = join(root, 'input.json')
    const manifest = join(root, 'manifest.json')
    const routes = join(root, 'golden.jsonc')
    const devVars = join(root, 'dev-vars')
    const repositoryId = '00000000-0000-4000-8000-000000000001'
    const resourceId = '00000000-0000-4000-8000-000000000002'
    const record = { hmac: { name: 'HMAC_GITHUB_OWNER_REPO', value: 'synthetic-recovery-cli-hmac' }, slugs: { activity: 'synthetic-cli-activity-route', stars: 'synthetic-cli-stars-route', alerts: 'synthetic-cli-alerts-route' }, profiles: ['activity'], state: 'active', provider: { kind: 'hookrelay-handoff-v1', authorityId: 'a'.repeat(32), workspaceId: 'alpha', repositoryId, bundleRevision: 1, resources: { activity: { resourceId, authMode: 'environment' } } } }
    const route = { name: 'github:Owner/Repo', source: 'github', enabled: true, sinks: ['discord:repo-activity'], auth: { scheme: 'github-sha256', secretEnv: record.hmac.name }, slugHash: await hashSubscriptionSlug(record.slugs.activity), githubHandoff: { authorityId: record.provider.authorityId, workspaceId: 'alpha', repositoryId, resourceId, repository: 'Owner/Repo', profile: 'activity' }, setup: { github: { repo: 'Owner/Repo', eventProfiles: ['activity'] } } }
    await writeFile(input, JSON.stringify({ version: 1, repository: 'Owner/Repo', origin: 'https://hooks.example', record, routes: [route], exportedAt: new Date().toISOString() }), { mode: 0o600 })
    await writeFile(manifest, '{"version":4,"repositories":{},"retiredRepositories":{}}', { mode: 0o600 })
    await writeFile(routes, '{"subs":[],"sinks":[{"name":"discord:repo-activity","type":"discord","urlEnv":"SYNTHETIC_DISCORD_URL"}]}')
    await writeFile(devVars, 'UNRELATED_VARIABLE=retained\n', { mode: 0o600 })
    const args = ['import', '-i', input, '-m', manifest, '-r', routes, '-d', devVars, '-y']
    const result = await runRecovery(args)
    assert.equal(result.manifestWritten, true)
    assert.ok(!JSON.stringify(result).includes(record.hmac.value))
    const first = await Promise.all([manifest, routes, devVars].map(path => readFile(path, 'utf8')))
    assert.equal(JSON.parse(first[0]).version, 5)
    assert.equal(JSON.parse(first[1]).subs[0].githubHandoff.resourceId, resourceId)
    assert.ok(first[2].includes('UNRELATED_VARIABLE=retained'))
    await runRecovery(args)
    assert.deepEqual(await Promise.all([manifest, routes, devVars].map(path => readFile(path, 'utf8'))), first)
  } finally { await rm(root, { recursive: true, force: true }) }
})
