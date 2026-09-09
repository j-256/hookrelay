import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { parseConfigurationArgs, readPrivateConfigurationFile, writeNewPrivateConfigurationFile } from '../../scripts/configuration.ts'
import { configurationDatabaseId, createOperatorConfigurationQuery } from '../../scripts/configuration-client.ts'

const exec = promisify(execFile)
const PRIVATE = 'synthetic-private-input'
const DATABASE = '00000000-0000-4000-8000-000000000005'
const environment = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: PRIVATE }

test('configuration arguments support equivalent short and long forms with strict command options', () => {
  const expected = { command: 'import-review', input: 'draft', output: 'review', config: 'wrangler.jsonc', yes: false }
  for (const args of [
    ['import-review', '-i', 'draft', '-o', 'review'],
    ['--input=draft', 'import-review', '--output=review'],
    ['-idraft', '-oreview', '--', 'import-review'],
  ]) assert.deepEqual(parseConfigurationArgs(args), expected)
  assert.equal(parseConfigurationArgs(['-h']), null)
  assert.equal(parseConfigurationArgs(['--help']), null)
  assert.equal(parseConfigurationArgs(['apply', '-yi', 'review']).yes, true)
  for (const args of [
    [], ['unknown'], ['status', '-y'], ['export'], ['export', '-o'], ['export', '--output='],
    ['export', '-o', 'one', '-o', 'two'], ['status', '--unknown'], ['receipt', '-p', 'invalid'],
    ['migration-review', '-r', 'routes', '-o', 'review', '-c', 'other.jsonc'],
    ['status', '--', 'extra'],
  ]) assert.throws(() => parseConfigurationArgs(args), { code: 'validation' })
})

test('private configuration files have real restrictive modes and cannot overwrite or follow existing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-private-review-'))
  const target = join(directory, 'review.json')
  const link = join(directory, 'link.json')
  try {
    await writeNewPrivateConfigurationFile(target, { private: PRIVATE })
    const targetFile = await open(target, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      assert.equal((await targetFile.stat()).mode & 0o777, 0o600)
      assert.deepEqual(JSON.parse(await readPrivateConfigurationFile(target)), { private: PRIVATE })
      await assert.rejects(writeNewPrivateConfigurationFile(target, {}), { code: 'validation' })
      assert.match(await targetFile.readFile('utf8'), new RegExp(PRIVATE))
      await symlink(target, link)
      await assert.rejects(readPrivateConfigurationFile(link), { code: 'validation' })
      await assert.rejects(writeNewPrivateConfigurationFile(link, {}), { code: 'validation' })
      await targetFile.chmod(0o644)
      await assert.rejects(readPrivateConfigurationFile(target), { code: 'validation' })
      await targetFile.chmod(0o600)
      await targetFile.truncate(1024 * 1024 + 1)
      await assert.rejects(readPrivateConfigurationFile(target), { code: 'validation' })
    } finally {
      await targetFile.close()
    }
    await assert.rejects(readPrivateConfigurationFile(directory), { code: 'validation' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the operator query uses an exact account/database, binds private values and redacts provider failures', async () => {
  assert.equal(configurationDatabaseId(JSON.stringify({ d1_databases: [{ binding: 'EVENTS_DB', database_id: DATABASE }] })), DATABASE)
  assert.throws(() => configurationDatabaseId('{private-invalid'), { code: 'validation' })
  const seen = []
  const query = createOperatorConfigurationQuery(DATABASE, environment, async (url, options) => {
    seen.push({ url, options })
    return Response.json({ success: true, result: [{ success: true, results: [{ verified: 1 }] }] })
  })
  assert.deepEqual(await query({ sql: 'SELECT ? AS value', params: [PRIVATE] }), [{ verified: 1 }])
  assert.equal(seen[0].url, `https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/d1/database/${DATABASE}/query`)
  assert.equal(seen[0].options.redirect, 'error')
  assert.deepEqual(JSON.parse(seen[0].options.body), { sql: 'SELECT ? AS value', params: [PRIVATE] })
  for (const fetcher of [
    async () => new Response(PRIVATE, { status: 403 }),
    async () => { throw new Error(PRIVATE) },
    async () => Response.json({ success: false, errors: [PRIVATE] }),
    async () => new Response(PRIVATE.repeat(200000)),
  ]) {
    const failing = createOperatorConfigurationQuery(DATABASE, environment, fetcher)
    await assert.rejects(failing({ sql: 'SELECT 1', params: [] }), error => error.code === 'unavailable' && !error.message.includes(PRIVATE))
  }
})

test('CLI help is dependency-free and usage failures keep stdout clean', async () => {
  const cleanEnvironment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' }
  for (const help of ['-h', '--help']) {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', 'scripts/configuration.ts', help], { env: cleanEnvironment })
    assert.match(stdout, /^usage:/)
    assert.equal(stderr, '')
  }
  for (const args of [['export'], ['status']]) {
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'scripts/configuration.ts', ...args], { env: cleanEnvironment }), error => {
      assert.equal(error.code, 2)
      assert.equal(error.stdout, '')
      assert.notEqual(error.stderr, '')
      assert.equal(error.stderr.includes(PRIVATE), false)
      return true
    })
  }
})

test('provider operator entrypoints no longer reject the active authority', async () => {
  const files = [
    'scripts/sync.ts', 'scripts/sub-add.ts', 'scripts/sink-add.ts', 'scripts/sub-retire.ts', 'scripts/sink-retire.ts',
    'scripts/sink-rename.ts', 'scripts/sink-secret-rename.ts', 'scripts/retention.ts',
    'scripts/providers/github/subscription-events.ts',
    'integrations/github-fleet/src/cli.ts', 'integrations/subscription-fleet/src/cli.ts',
  ]
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const main = source.slice(source.indexOf('async function main('))
    assert.doesNotMatch(main, /requireLegacyConfiguration/, file)
  }
})
