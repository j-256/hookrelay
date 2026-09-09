// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import packageJson from '../../package.json'
import {
  checkProductionMigrations,
  migrationLedgerStatement,
  parseReleaseMigrationConfig,
  requireCurrentProductionMigrations,
  type ReleaseCheckDependencies,
} from '../../scripts/release-check'

const DATABASE_ID = '00000000-0000-4000-8000-000000000006'
const MIGRATIONS = ['0001_init.sql', '0002_next.sql']

function wranglerConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    d1_databases: [{
      binding: 'EVENTS_DB',
      database_id: DATABASE_ID,
      ...overrides,
    }],
  })
}

function dependencies(applied = MIGRATIONS): ReleaseCheckDependencies {
  return {
    readConfig: vi.fn(async () => wranglerConfig()),
    listMigrations: vi.fn(async () => MIGRATIONS),
    query: vi.fn(async () => applied.map((name) => ({ name }))),
    log: vi.fn(),
  }
}

describe('release migration verification', () => {
  it('wires production migration verification ahead of release tests', () => {
    expect(packageJson.scripts['release:check']).toBe('tsx scripts/release-check.ts')
    expect(packageJson.scripts.preversion).toBe('[ "$(git branch --show-current)" = main ] || { echo \'Error: npm version must be run on main\'; exit 1; } && pnpm release:check && npm run typecheck && npm test')
  })

  it('reads default and explicit migration settings for EVENTS_DB', () => {
    expect(parseReleaseMigrationConfig(wranglerConfig(), '/project/wrangler.jsonc')).toEqual({
      databaseId: DATABASE_ID,
      migrationsDirectory: '/project/migrations',
      migrationsTable: 'd1_migrations',
    })
    expect(parseReleaseMigrationConfig(wranglerConfig({
      migrations_dir: 'schema',
      migrations_table: 'release"ledger',
    }), '/project/wrangler.jsonc')).toEqual({
      databaseId: DATABASE_ID,
      migrationsDirectory: '/project/schema',
      migrationsTable: 'release"ledger',
    })
    expect(() => parseReleaseMigrationConfig(wranglerConfig({ migrations_pattern: 'schema/*.sql' }))).toThrow(/migrations_pattern/)
    expect(() => parseReleaseMigrationConfig('{')).toThrow(/valid D1 migration configuration/)
  })

  it('quotes the configured migration ledger table', () => {
    expect(migrationLedgerStatement('release"ledger')).toEqual({
      sql: 'SELECT name FROM "release""ledger" ORDER BY id',
      params: [],
    })
  })

  it('blocks pending, untracked, empty, and duplicate migration ledgers', () => {
    expect(() => requireCurrentProductionMigrations(MIGRATIONS, [MIGRATIONS[0]!])).toThrow(/0002_next\.sql/)
    expect(() => requireCurrentProductionMigrations(MIGRATIONS, [...MIGRATIONS, '0003_remote.sql'])).toThrow(/untracked files/)
    expect(() => requireCurrentProductionMigrations([], [])).toThrow(/No tracked/)
    expect(() => requireCurrentProductionMigrations(MIGRATIONS, [MIGRATIONS[0]!, MIGRATIONS[0]!])).toThrow(/duplicate/)
  })

  it('queries production and reports a matching migration ledger', async () => {
    const deps = dependencies()
    await expect(checkProductionMigrations(deps, '/project/wrangler.jsonc')).resolves.toBeUndefined()
    expect(deps.listMigrations).toHaveBeenCalledWith('/project/migrations')
    expect(deps.query).toHaveBeenCalledWith(DATABASE_ID, migrationLedgerStatement('d1_migrations'))
    expect(deps.log).toHaveBeenCalledWith('Production D1 migrations are current (2 applied)')
  })

  it('fails closed when production returns malformed ledger rows', async () => {
    const deps = dependencies()
    deps.query = vi.fn(async () => [{ migration: MIGRATIONS[0] }])
    await expect(checkProductionMigrations(deps)).rejects.toThrow(/invalid migration ledger/)
  })
})
