import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseEnv } from 'node:util'

export interface SecretValue {
  name: string
  value: string
}

export interface FileSystemStat {
  mode: number
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface AtomicFileSystem {
  chmod(path: string, mode: number): Promise<void>
  lstat(path: string): Promise<FileSystemStat>
  open: typeof open
  rename(source: string, target: string): Promise<void>
  unlink(path: string): Promise<void>
}

const NODE_FILE_SYSTEM: AtomicFileSystem = { chmod, lstat, open, rename, unlink }

export type ProductionResult = 'local-only' | 'previewed' | 'applied'

export const WRANGLER_BULK_SECRET_LIMIT = 100

interface ProcessOptions {
  input?: string
  captureStdout?: boolean
}

export function envSegment(value: string): string {
  const segment = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!segment) throw new Error('name must contain at least one letter or number')
  return segment
}

export function addDevVar(text: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const existing = new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=`, 'm')
  if (existing.test(text)) throw new Error(`${name} already exists in .dev.vars`)

  const prefix = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  return `${prefix}${name}=${value}\n`
}

export function setDevVar(text: string, name: string, value: string): string {
  const existing = getDevVar(text, name)
  if (existing === null) return addDevVar(text, name, value)
  if (existing !== value) throw new Error(`${name} already exists in .dev.vars with a different value`)
  return text
}

export function getDevVar(text: string, name: string): string | null {
  let parsed: ReturnType<typeof parseEnv>
  try {
    parsed = parseEnv(text)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse .dev.vars: ${message}`)
  }
  return parsed[name] ?? null
}

export function removeDevVar(text: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=`)
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? []
  const matching = lines.filter((line) => assignment.test(line))
  if (matching.length === 0) throw new Error(`${name} does not exist in .dev.vars`)
  if (matching.length > 1) throw new Error(`${name} appears more than once in .dev.vars`)
  return lines.filter((line) => !assignment.test(line)).join('')
}

export async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export async function privateFileIssue(path: string, fileSystem: AtomicFileSystem | undefined = NODE_FILE_SYSTEM): Promise<string | null> {
  const fs = fileSystem ?? NODE_FILE_SYSTEM
  try {
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) return `${path} must not be a symbolic link`
    if (!info.isFile()) return `${path} must be a regular file`
    if ((info.mode & 0o777) !== 0o600) return `${path} must have mode 0600`
    return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function readPrivateOptionalText(path: string, fileSystem: AtomicFileSystem | undefined = NODE_FILE_SYSTEM): Promise<string> {
  const issue = await privateFileIssue(path, fileSystem)
  if (issue) throw new Error(issue)
  return readOptionalText(path)
}

async function writeAtomicText(
  path: string,
  text: string,
  mode: number,
  requirePrivateMode: boolean,
  fileSystem: AtomicFileSystem,
): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  const backupPath = `${tempPath}.backup`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let backupExists = false
  try {
    handle = await fileSystem.open(tempPath, 'wx', mode)
    await fileSystem.chmod(tempPath, mode)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await fileSystem.rename(tempPath, path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      await fileSystem.rename(path, backupPath)
      backupExists = true
      try {
        await fileSystem.rename(tempPath, path)
      } catch (replacementErr) {
        await fileSystem.rename(backupPath, path)
        backupExists = false
        throw replacementErr
      }
      await fileSystem.unlink(backupPath)
      backupExists = false
    }
    await fileSystem.chmod(path, mode)
    if (requirePrivateMode) {
      const info = await fileSystem.lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
        throw new Error(`${path} was not written as a private regular file with mode 0600 (found ${(info.mode & 0o777).toString(8)})`)
      }
    }
  } catch (err) {
    await handle?.close().catch(() => undefined)
    if (backupExists) {
      await fileSystem.rename(backupPath, path).catch(() => undefined)
    }
    await fileSystem.unlink(tempPath).catch((unlinkErr) => {
      if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr
    })
    throw err
  }
}

export async function writePrivateText(
  path: string,
  text: string,
  fileSystem: AtomicFileSystem = NODE_FILE_SYSTEM,
): Promise<void> {
  await writeAtomicText(path, text, 0o600, true, fileSystem)
}

export async function writeText(
  path: string,
  text: string,
  fileSystem: AtomicFileSystem = NODE_FILE_SYSTEM,
): Promise<void> {
  await writeAtomicText(path, text, 0o644, false, fileSystem)
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(`${question} [y/N] `)
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    prompt.close()
  }
}

export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const value = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '')
    if (!value) throw new Error('secret input was empty')
    return value
  }

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const input = process.stdin
    const output = process.stderr
    const wasRaw = input.isRaw

    const finish = (err?: Error) => {
      input.off('data', onData)
      input.setRawMode(Boolean(wasRaw))
      input.pause()
      output.write('\n')
      if (err) reject(err)
      else if (!value) reject(new Error('secret input was empty'))
      else resolve(value)
    }

    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') {
          finish(new Error('cancelled'))
          return
        }
        if (char === '\r' || char === '\n') {
          finish()
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }

    output.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

export async function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [options.input === undefined ? 'inherit' : 'pipe', options.captureStdout ? 'pipe' : 'inherit', 'inherit'],
    })
    const stdout: Buffer[] = []

    child.once('error', reject)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
        return
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`))
    })

    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

export async function putWranglerSecret(secret: SecretValue): Promise<void> {
  await runProcess('npx', ['wrangler', 'secret', 'put', secret.name], { input: `${secret.value}\n` })
}

export async function deleteWranglerSecret(name: string): Promise<void> {
  // Wrangler sees piped stdin as non-interactive after our own confirmation
  await runProcess('npx', ['wrangler', 'secret', 'delete', name], { input: '' })
}

export async function listWranglerSecrets(runner: typeof runProcess = runProcess): Promise<Set<string>> {
  const stdout = await runner('npx', ['wrangler', 'secret', 'list'], { captureStdout: true })
  const items = JSON.parse(stdout) as Array<{ name: string }>
  return new Set(items.map((item) => item.name))
}

async function patchWranglerSecretsBulk(
  values: Readonly<Record<string, string | null>>,
  runner: typeof runProcess = runProcess,
): Promise<Set<string>> {
  const entries = Object.entries(values)
  if (entries.length === 0) return listWranglerSecrets(runner)
  if (entries.length > WRANGLER_BULK_SECRET_LIMIT) {
    throw new Error(`Wrangler accepts at most ${WRANGLER_BULK_SECRET_LIMIT} secrets per bulk operation`)
  }
  for (const [name, value] of entries) {
    if (!name) throw new Error('Wrangler secret name is empty')
    if (value === '') throw new Error(`Wrangler secret ${name} is empty`)
  }

  await runner('npx', ['wrangler', 'secret', 'bulk'], {
    input: `${JSON.stringify(values)}\n`,
  })
  const names = await listWranglerSecrets(runner)
  for (const [name, value] of entries) {
    if (value === null && names.has(name)) throw new Error(`Wrangler secret ${name} still exists after bulk deletion`)
    if (value !== null && !names.has(name)) throw new Error(`Wrangler secret ${name} is missing after bulk update`)
  }
  return names
}

export async function putWranglerSecretsBulk(
  secrets: readonly SecretValue[],
  runner: typeof runProcess = runProcess,
): Promise<Set<string>> {
  const values: Record<string, string> = {}
  for (const secret of secrets) {
    if (Object.prototype.hasOwnProperty.call(values, secret.name)) {
      throw new Error(`Wrangler secret supplied more than once: ${secret.name}`)
    }
    values[secret.name] = secret.value
  }
  return patchWranglerSecretsBulk(values, runner)
}

export async function deleteWranglerSecretsBulk(
  names: readonly string[],
  runner: typeof runProcess = runProcess,
): Promise<Set<string>> {
  const values: Record<string, null> = {}
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Wrangler secret supplied more than once: ${name}`)
    }
    values[name] = null
  }
  return patchWranglerSecretsBulk(values, runner)
}

export async function runSync(apply: boolean, routesPath?: string): Promise<void> {
  await runProcess('npx', [
    'tsx',
    'scripts/sync.ts',
    ...(routesPath ? ['--routes', routesPath] : []),
    ...(apply ? ['--yes'] : []),
  ])
}

export async function prepareProduction(secrets: SecretValue | SecretValue[] | null, yes: boolean): Promise<ProductionResult> {
  const secretList = secrets === null ? [] : Array.isArray(secrets) ? secrets : [secrets]
  const secretNames = secretList.map((secret) => secret.name).join(', ')
  const action = secretList.length > 0
    ? `Set ${secretNames} in Wrangler and preview the production KV plan?`
    : 'Preview the production KV plan?'
  if (!yes && !(await confirm(action))) return 'local-only'

  if (secretList.length === 1) await putWranglerSecret(secretList[0]!)
  if (secretList.length > 1) await putWranglerSecretsBulk(secretList)
  if (yes) {
    await runSync(true)
    return 'applied'
  }

  await runSync(false)
  if (!(await confirm('Apply this production KV plan?'))) return 'previewed'
  await runSync(true)
  return 'applied'
}
