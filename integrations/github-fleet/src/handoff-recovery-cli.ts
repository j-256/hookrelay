import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseArgs } from 'node:util'
import { readPrivateConfigurationFile } from '../../../scripts/configuration'
import { setDevVar, writePrivateText, writeText } from '../../../scripts/setup'
import { parseHandoffRecoveryEnvelope, mergeHandoffRecovery } from './handoff-recovery'

const execute = promisify(execFile)
const MAX_ROUTES_BYTES = 2 * 1024 * 1024
export const RECOVERY_USAGE = `Usage: pnpm github:handoff:recovery <inspect|import> -i <export> -m <manifest> [options]

  -i, --input <file>      One-repository version-1 private provider export
  -m, --manifest <file>   Existing private fleet manifest (versions 2 through 5)
  -r, --routes <file>     Optional explicit authoritative golden JSONC routes
  -d, --dev-vars <file>   Optional existing private development variables
  -y, --yes              Confirm import after inspecting the identical selection
  -h, --help             Show help

Private files must be regular non-symlink files with mode 0600. A manifest in Git must have filter=git-crypt and diff=unset. Routes must be the authoritative source, never a linked runtime target. Import writes recovery first, routes second, and development variables last. Repeat an interrupted import with the same export. Only environment-authenticated profiles need the development HMAC mirror; bundle profiles need the provider keyring separately.

Requires Node.js, the locked project dependencies, and Git. No environment credentials are used. Results contain metadata only; values never belong in arguments. Exit statuses: 0 success, 1 runtime or partial failure, 2 usage/precondition failure, 3 missing Git.`

class RecoveryError extends Error {
  constructor(readonly exitCode: number, message: string) { super(message) }
}
export function parseRecoveryArgs(args: string[]) {
  try {
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
      input: { type: 'string', short: 'i' }, manifest: { type: 'string', short: 'm' }, routes: { type: 'string', short: 'r' },
      'dev-vars': { type: 'string', short: 'd' }, yes: { type: 'boolean', short: 'y' }, help: { type: 'boolean', short: 'h' },
    } })
    if (values.help) return { help: true as const }
    const seen = new Set<string>()
    for (const token of tokens) if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error()
      seen.add(token.name)
    }
    if (positionals.length !== 1 || !['inspect', 'import'].includes(positionals[0]!) || !values.input || !values.manifest ||
      Object.values(values).some(value => value === '') || (positionals[0] === 'import' && !values.yes) || (positionals[0] === 'inspect' && values.yes)) throw new Error()
    return { help: false as const, command: positionals[0]!, input: resolve(values.input), manifest: resolve(values.manifest),
      routes: values.routes ? resolve(values.routes) : undefined, devVars: values['dev-vars'] ? resolve(values['dev-vars']) : undefined }
  } catch { throw new RecoveryError(2, 'Invalid recovery arguments; use --help') }
}
async function readRoutes(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_ROUTES_BYTES) throw new Error()
    const text = await file.readFile('utf8')
    if (Buffer.byteLength(text) > MAX_ROUTES_BYTES) throw new Error()
    return text
  } finally { await file.close() }
}
async function checkManifestEncryption(path: string) {
  try { await execute('git', ['--version']) } catch { throw new RecoveryError(3, 'Git is required to verify recovery storage') }
  let root: string
  try { root = (await execute('git', ['-C', dirname(path), 'rev-parse', '--show-toplevel'])).stdout.trim() }
  catch { return }
  const { stdout } = await execute('git', ['-C', root, 'check-attr', '-z', 'filter', 'diff', '--', relative(root, path)])
  const parts = stdout.split('\0')
  const attrs = new Map<string, string>()
  for (let i = 0; i + 2 < parts.length; i += 3) attrs.set(parts[i + 1]!, parts[i + 2]!)
  if (attrs.get('filter') !== 'git-crypt' || attrs.get('diff') !== 'unset') throw new RecoveryError(2, 'Git recovery storage requires filter=git-crypt and diff=unset')
}
export async function runRecovery(args: string[]): Promise<unknown> {
  const options = parseRecoveryArgs(args)
  if (options.help) return RECOVERY_USAGE
  let stage = 'validate'
  let manifestWritten = false
  try {
    const paths = [options.input, options.manifest, options.routes, options.devVars].filter((value): value is string => Boolean(value))
    const identities = await Promise.all(paths.map(async path => { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const s = await file.stat(); return `${s.dev}:${s.ino}` } finally { await file.close() } }))
    if (new Set(identities).size !== identities.length) throw new RecoveryError(2, 'Recovery input and output files must be distinct')
    await checkManifestEncryption(options.manifest)
    const [input, manifest, routes, devVars] = await Promise.all([
      readPrivateConfigurationFile(options.input), readPrivateConfigurationFile(options.manifest),
      options.routes ? readRoutes(options.routes) : undefined, options.devVars ? readPrivateConfigurationFile(options.devVars) : undefined,
    ])
    const envelope = await parseHandoffRecoveryEnvelope(input)
    const merged = await mergeHandoffRecovery(manifest, routes, envelope)
    const needsHmac = Object.values(envelope.record.provider.resources).some(value => value.authMode === 'environment')
    const nextDevVars = devVars !== undefined && needsHmac ? setDevVar(devVars, envelope.record.hmac.name, envelope.record.hmac.value) : devVars
    if (options.command === 'import') {
      const originals = await Promise.all([readPrivateConfigurationFile(options.input), readPrivateConfigurationFile(options.manifest), options.routes ? readRoutes(options.routes) : undefined, options.devVars ? readPrivateConfigurationFile(options.devVars) : undefined])
      if (originals.some((value, index) => value !== [input, manifest, routes, devVars][index])) throw new RecoveryError(2, 'Recovery files changed during inspection; rerun the identical import')
      stage = 'manifest'
      await writePrivateText(options.manifest, merged.manifestText)
      manifestWritten = true
      if (await readPrivateConfigurationFile(options.manifest) !== merged.manifestText) throw new Error()
      stage = 'routes'
      if (options.routes && merged.routesText !== routes) await writeText(options.routes, merged.routesText!)
      if (options.routes && await readRoutes(options.routes) !== merged.routesText) throw new Error()
      stage = 'dev-vars'
      if (options.devVars && nextDevVars !== devVars) await writePrivateText(options.devVars, nextDevVars!)
      if (options.devVars && await readPrivateConfigurationFile(options.devVars) !== nextDevVars) throw new Error()
    }
    return { command: options.command, repository: envelope.repository, profiles: envelope.record.profiles, manifestWritten, routesSelected: Boolean(options.routes), developmentMirrorSelected: Boolean(options.devVars) }
  } catch (error) {
    if (error instanceof RecoveryError) throw error
    throw new RecoveryError(stage === 'validate' ? 2 : 1, `Recovery ${stage} failed; manifestWritten=${manifestWritten}. Keep the private export and retry the identical selection`)
  }
}
if (import.meta.main) runRecovery(process.argv.slice(2)).then(value => console.log(typeof value === 'string' ? value : JSON.stringify(value))).catch(error => {
  console.error(error instanceof RecoveryError ? error.message : 'Recovery failed')
  process.exitCode = error instanceof RecoveryError ? error.exitCode : 1
})
