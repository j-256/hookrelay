import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { putRemoteKv } from '../../scripts/kv.ts'
import { runProcess } from '../../scripts/setup.ts'

const PRIVATE = 'synthetic-private-value-with-spaces\nand-a-newline\n'
const KEY = 'sink:synthetic'
const exec = promisify(execFile)

test('KV values use exact owner-only file input, not arguments or output', async () => {
  let valuePath
  let observed
  await putRemoteKv('SINKS', KEY, PRIVATE, async (command, args, options) => {
    valuePath = args[args.indexOf('--path') + 1]
    const handle = await open(valuePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const file = await handle.stat()
      observed = {
        command, prefix: args.slice(0, 5), privateArgument: args.includes(PRIVATE),
        exactValue: await handle.readFile('utf8') === PRIVATE,
        file: file.isFile(), symlink: file.isSymbolicLink(), mode: file.mode & 0o777,
        directoryMode: (await lstat(dirname(valuePath))).mode & 0o777, options,
      }
    } finally {
      await handle.close()
    }
    return ''
  })
  assert.deepEqual(observed, {
    command: 'npx', prefix: ['wrangler', 'kv', 'key', 'put', KEY], privateArgument: false,
    exactValue: true, file: true, symlink: false, mode: 0o600, directoryMode: 0o700,
    options: { privateOutput: true },
  })
  await assert.rejects(lstat(valuePath), { code: 'ENOENT' })
  await assert.rejects(lstat(dirname(valuePath)), { code: 'ENOENT' })
})

test('failed writes remove temporary values and suppress private error details', async () => {
  let valuePath
  await assert.rejects(putRemoteKv('SINKS', KEY, PRIVATE, async (_command, args) => {
    valuePath = args[args.indexOf('--path') + 1]
    throw new Error(PRIVATE)
  }), { message: 'KV write outcome is unverified in SINKS; inspect remote configuration before retrying' })
  await assert.rejects(lstat(dirname(valuePath)), { code: 'ENOENT' })
})

test('private child processes suppress both streams and force safe Wrangler logging', async () => {
  const script = `
    import { runProcess } from './scripts/setup.ts'
    process.env.WRANGLER_LOG_SANITIZE = 'false'
    process.env.WRANGLER_WRITE_LOGS = 'true'
    await runProcess(process.execPath, ['-e', \`
      process.stdout.write('synthetic-sensitive-output')
      process.stderr.write('synthetic-sensitive-error')
      if (process.env.WRANGLER_LOG_SANITIZE !== 'true' ||
          process.env.WRANGLER_WRITE_LOGS !== 'false' ||
          process.env.WRANGLER_SEND_METRICS !== 'false') process.exit(7)
    \`], { privateOutput: true, captureStdout: true })
  `
  const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])
  assert.equal(stdout, '')
  assert.equal(stderr, '')
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], { privateOutput: true }), /exited with code 7/)
})

test('private reads capture values in memory without forwarding child diagnostics', async () => {
  const script = `
    import { runProcess } from './scripts/setup.ts'
    const value = await runProcess(process.execPath, ['-e', \`
      process.stdout.write('synthetic-private-result')
      process.stderr.write('synthetic-private-diagnostic')
      if (process.env.WRANGLER_WRITE_LOGS !== 'false') process.exit(7)
    \`], { privateInput: true, captureStdout: true })
    if (value !== 'synthetic-private-result') process.exit(8)
  `
  const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script])
  assert.equal(stdout, '')
  assert.equal(stderr, '')
})

test('the installed Wrangler accepts file input locally without logging the value', async () => {
  const require = createRequire(import.meta.url)
  const wrangler = join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
  const directory = await mkdtemp(join(tmpdir(), 'hookrelay-kv-probe-'))
  const environment = {
    ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '',
    WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false',
  }
  const common = ['--local', '--persist-to', directory, '--config', resolve('wrangler.jsonc')]
  try {
    await putRemoteKv('SINKS', KEY, PRIVATE, async (_command, args) => {
      const { stdout, stderr } = await exec(process.execPath,
        [wrangler, ...args.slice(1).filter(value => value !== '--remote'), ...common],
        { env: environment })
      assert.equal(stdout.includes(PRIVATE), false)
      assert.equal(stderr.includes(PRIVATE), false)
      return ''
    })
    const { stdout } = await exec(process.execPath,
      [wrangler, 'kv', 'key', 'get', KEY, '--binding', 'SINKS', ...common],
      { env: environment })
    assert.equal(stdout, PRIVATE)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
