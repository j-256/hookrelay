import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import type { ConfigurationStatement } from '../src/configuration/authority'
import { createOperatorConfigurationQuery } from './configuration-client'

const WRANGLER_CONFIG_PATH = 'wrangler.jsonc'
const EVENTS_DATABASE_BINDING = 'EVENTS_DB'
const DEFAULT_MIGRATIONS_DIRECTORY = './migrations'
const DEFAULT_MIGRATIONS_TABLE = 'd1_migrations'
const MIGRATION_FILE_SUFFIX = '.sql'
const APPLY_MIGRATIONS_COMMAND = 'pnpm exec wrangler d1 migrations apply EVENTS_DB --remote'

const databaseSchema = z.object({
  binding: z.string(),
  database_id: z.uuid(),
  migrations_dir: z.string().trim().min(1).optional(),
  migrations_table: z.string().trim().min(1).optional(),
  migrations_pattern: z.string().optional(),
}).passthrough()
const wranglerSchema = z.object({ d1_databases: z.array(databaseSchema) }).passthrough()
const appliedMigrationSchema = z.array(z.object({ name: z.string().min(1) }).passthrough())

export interface ReleaseMigrationConfig {
  databaseId: string
  migrationsDirectory: string
  migrationsTable: string
}

export interface ReleaseCheckDependencies {
  readConfig(path: string): Promise<string>
  listMigrations(directory: string): Promise<string[]>
  query(databaseId: string, statement: ConfigurationStatement): Promise<unknown[]>
  log(message: string): void
}

const DEFAULT_DEPENDENCIES: ReleaseCheckDependencies = {
  readConfig: (path) => readFile(path, 'utf8'),
  listMigrations: async (directory) => (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(MIGRATION_FILE_SUFFIX))
    .map((entry) => entry.name)
    .sort(),
  query: async (databaseId, statement) => createOperatorConfigurationQuery(databaseId)(statement),
  log: console.log,
}

export function parseReleaseMigrationConfig(text: string, configPath = WRANGLER_CONFIG_PATH): ReleaseMigrationConfig {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true })
  const config = wranglerSchema.safeParse(parsed)
  if (errors.length > 0 || !config.success) {
    throw new Error('wrangler.jsonc must contain valid D1 migration configuration')
  }
  const databases = config.data.d1_databases.filter((entry) => entry.binding === EVENTS_DATABASE_BINDING)
  if (databases.length !== 1) {
    throw new Error('wrangler.jsonc must identify exactly one EVENTS_DB database')
  }
  const database = databases[0]!
  if (database.migrations_pattern !== undefined) {
    throw new Error('release migration verification does not support migrations_pattern')
  }
  return {
    databaseId: database.database_id,
    migrationsDirectory: resolve(dirname(resolve(configPath)), database.migrations_dir ?? DEFAULT_MIGRATIONS_DIRECTORY),
    migrationsTable: database.migrations_table ?? DEFAULT_MIGRATIONS_TABLE,
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

export function migrationLedgerStatement(table: string): ConfigurationStatement {
  return { sql: `SELECT name FROM ${quoteIdentifier(table)} ORDER BY id`, params: [] }
}

export function requireCurrentProductionMigrations(local: readonly string[], applied: readonly string[]): void {
  if (local.length === 0) throw new Error('No tracked D1 migrations were found')
  if (new Set(local).size !== local.length) throw new Error('Tracked D1 migration names must be unique')
  if (new Set(applied).size !== applied.length) throw new Error('Production D1 migration ledger contains duplicate names')

  const localNames = new Set(local)
  const appliedNames = new Set(applied)
  const absent = applied.filter((name) => !localNames.has(name))
  if (absent.length > 0) {
    throw new Error(`Production D1 migration ledger references untracked files: ${absent.join(', ')}`)
  }
  const pending = local.filter((name) => !appliedNames.has(name))
  if (pending.length > 0) {
    throw new Error(`Production D1 migrations are pending: ${pending.join(', ')}. Run ${APPLY_MIGRATIONS_COMMAND} before releasing`)
  }
}

export async function checkProductionMigrations(
  dependencies: ReleaseCheckDependencies = DEFAULT_DEPENDENCIES,
  configPath = WRANGLER_CONFIG_PATH,
): Promise<void> {
  const config = parseReleaseMigrationConfig(await dependencies.readConfig(configPath), configPath)
  const local = await dependencies.listMigrations(config.migrationsDirectory)
  const rows = await dependencies.query(config.databaseId, migrationLedgerStatement(config.migrationsTable))
  const applied = appliedMigrationSchema.safeParse(rows)
  if (!applied.success) throw new Error('Production D1 returned an invalid migration ledger')
  requireCurrentProductionMigrations(local, applied.data.map((row) => row.name))
  dependencies.log(`Production D1 migrations are current (${local.length} applied)`)
}

if (import.meta.main) {
  checkProductionMigrations().catch((error) => {
    console.error(`Release blocked: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
