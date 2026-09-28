import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { parseOperationsArgs } from '../../scripts/operations.ts'

const exec = promisify(execFile)
test('operational CLI supports standard option forms and rejects incomplete or ambiguous commands', () => {
  for (const args of [['plan', '-i', 'review'], ['--input=review', 'plan'], ['-ireview', '--', 'plan']]) {
    assert.deepEqual(parseOperationsArgs(args), { command: 'plan', input: 'review', config: 'wrangler.jsonc' })
  }
  const id = '00000000-0000-4000-8000-000000000001'
  assert.equal(parseOperationsArgs(['apply', '-yp', id]).yes, true)
  for (const args of [[], ['plan'], ['apply'], ['apply', '-p', 'invalid'], ['signals', '-y'], ['plan', '-i'], ['plan', '--input='], ['signals', '--unknown'], ['plan', '-i', 'one', '-i', 'two']]) {
    assert.throws(() => parseOperationsArgs(args), { code: 'validation' })
  }
})

test('operational CLI help requires no provider credentials and keeps usage failures off stdout', async () => {
  const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' }
  for (const flag of ['-h', '--help']) {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', 'scripts/operations.ts', flag], { env: environment })
    assert.match(stdout, /^usage:/)
    assert.equal(stderr, '')
  }
  for (const command of ['signals', 'apply']) {
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'scripts/operations.ts', command], { env: environment }), error => {
      assert.equal(error.code, 2)
      assert.equal(error.stdout, '')
      assert.notEqual(error.stderr, '')
      return true
    })
  }
})
