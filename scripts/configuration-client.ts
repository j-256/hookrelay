import { readFile } from 'node:fs/promises'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import {
  CONFIGURATION_MODE, ConfigurationError, readConfigurationState, type ConfigurationQuery,
} from '../src/configuration/authority'

const OPERATOR_QUERY_LIMITS = Object.freeze({ TIMEOUT_MS: 15000, RESPONSE_BYTES: 2 * 1024 * 1024 })
export const CONFIGURATION_OPERATOR = Object.freeze({
  clientId: 'cloudflare-operator',
  clientRevision: 1,
  workspaceId: 'provider',
  actorId: 'account-operator',
})
const databaseConfig = z.object({
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.uuid() })),
})

export function configurationDatabaseId(text: string): string {
  try {
    const errors: ParseError[] = []
    const config = databaseConfig.parse(parseJsonc(text, errors, { allowTrailingComma: true }))
    const databases = config.d1_databases.filter(entry => entry.binding === 'EVENTS_DB')
    if (errors.length || databases.length !== 1) throw new Error()
    return databases[0]!.database_id
  } catch {
    throw new ConfigurationError('validation', 'The selected Wrangler configuration must identify exactly one EVENTS_DB database')
  }
}

export function createOperatorConfigurationQuery(
  databaseId: string,
  environment: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): ConfigurationQuery {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID
  const apiToken = environment.CLOUDFLARE_API_TOKEN
  if (!accountId || !apiToken) {
    throw new ConfigurationError('validation', 'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required')
  }
  if (!/^[a-f0-9]{32}$/.test(accountId) || !z.uuid().safeParse(databaseId).success) {
    throw new ConfigurationError('validation', 'The Cloudflare account or database identity is invalid')
  }
  return async <Row>(statement: Parameters<ConfigurationQuery>[0]): Promise<Row[]> => {
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(statement), signal: AbortSignal.timeout(OPERATOR_QUERY_LIMITS.TIMEOUT_MS), redirect: 'error',
      })
      if (!response.ok || !response.body) throw new Error()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > OPERATOR_QUERY_LIMITS.RESPONSE_BYTES) {
            await reader.cancel()
            throw new Error()
          }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { success?: boolean; result?: { success?: boolean; results?: Row[] }[] }
      if (body.success !== true || body.result?.length !== 1 || body.result[0]?.success !== true || !Array.isArray(body.result[0].results)) throw new Error()
      return body.result[0].results
    } catch {
      throw new ConfigurationError('unavailable', 'Configuration access is unavailable; verify D1 permissions and migrations, and reconcile uncertain writes by receipt')
    }
  }
}

export async function operatorConfigurationQuery(configPath = 'wrangler.jsonc'): Promise<ConfigurationQuery> {
  return createOperatorConfigurationQuery(configurationDatabaseId(await readFile(configPath, 'utf8')))
}

export async function requireLegacyConfiguration(query?: ConfigurationQuery): Promise<void> {
  const state = await readConfigurationState(query ?? await operatorConfigurationQuery())
  if (state.mode !== CONFIGURATION_MODE.LEGACY) {
    throw new ConfigurationError('inactive', 'This routes.jsonc workflow is unavailable with the active provider authority; use pnpm configuration or the reviewed online policy editor')
  }
}
