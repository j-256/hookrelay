import { spawn } from 'node:child_process'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'

export interface SecretValue {
  name: string
  value: string
}

export type ProductionResult = 'local-only' | 'previewed' | 'applied'

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

export async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export async function writePrivateText(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
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

export async function runSync(apply: boolean): Promise<void> {
  await runProcess('npx', ['tsx', 'scripts/sync.ts', ...(apply ? ['--yes'] : [])])
}

export async function prepareProduction(secret: SecretValue | null, yes: boolean): Promise<ProductionResult> {
  const action = secret
    ? `Set ${secret.name} in Wrangler and preview the production KV plan?`
    : 'Preview the production KV plan?'
  if (!yes && !(await confirm(action))) return 'local-only'

  if (secret) await putWranglerSecret(secret)
  if (yes) {
    await runSync(true)
    return 'applied'
  }

  await runSync(false)
  if (!(await confirm('Apply this production KV plan?'))) return 'previewed'
  await runSync(true)
  return 'applied'
}
