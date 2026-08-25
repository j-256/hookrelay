import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const IMPORT_SPECIFIER_RE = /\b(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g

function isWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

async function typescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return typescriptFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  }))
  return files.flat()
}

function relativeImportTargets(file: string, source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER_RE)]
    .map((match) => match[1]!)
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => resolve(dirname(file), specifier))
}

export async function dependencyBoundaryViolations(projectRoot: string): Promise<string[]> {
  const runtimeRoot = resolve(projectRoot, 'src')
  const scriptsRoot = resolve(projectRoot, 'scripts')
  const integrationsRoot = resolve(projectRoot, 'integrations')
  const githubFleetRoot = resolve(integrationsRoot, 'github-fleet')
  const subscriptionFleetRoot = resolve(integrationsRoot, 'subscription-fleet')
  const scannedRoots = [runtimeRoot, scriptsRoot, integrationsRoot, resolve(projectRoot, 'test')]
  const files = (await Promise.all(scannedRoots.map(typescriptFiles))).flat()
  const violations: string[] = []

  for (const file of files) {
    const source = await readFile(file, 'utf8')
    for (const target of relativeImportTargets(file, source)) {
      const importer = relative(projectRoot, file)
      const imported = relative(projectRoot, target)
      if (isWithin(file, runtimeRoot) && (isWithin(target, scriptsRoot) || isWithin(target, integrationsRoot))) {
        violations.push(`${importer} imports ${imported}`)
      }
      if (isWithin(file, scriptsRoot) && isWithin(target, integrationsRoot)) {
        violations.push(`${importer} imports ${imported}`)
      }
      if (!isWithin(file, githubFleetRoot) && isWithin(target, githubFleetRoot)) {
        violations.push(`${importer} imports ${imported}`)
      }
      if (!isWithin(file, subscriptionFleetRoot) && isWithin(target, subscriptionFleetRoot)) {
        violations.push(`${importer} imports ${imported}`)
      }
    }
  }

  return violations
}

if (import.meta.main) {
  dependencyBoundaryViolations(process.cwd()).then((violations) => {
    if (violations.length > 0) throw new Error(`dependency boundary violations:\n${violations.join('\n')}`)
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
