import { z } from 'zod'
import type { Sink } from '.'
import type { Env } from '../index'
import { postRaw } from '../lib/http'
import { readSecret } from '../lib/secret'
import type { Severity } from '../types'

const PRIORITY: Record<Severity, string> = {
  debug: '1',
  info: '2',
  warning: '3',
  error: '4',
  critical: '5',
}

const configSchema = z
  .object({
    topic: z.string().min(1),
    server: z.string().url().optional(),
    tokenEnv: z.string().min(1).optional(),
  })
  .strict()

type Config = z.infer<typeof configSchema>

const sink: Sink<Config> = {
  type: 'ntfy',
  configSchema,

  async send(event, config, env: Env, fetchFn) {
    const server = config.server ?? 'https://ntfy.sh'
    const url = `${server}/${encodeURIComponent(config.topic)}`
    const headers: Record<string, string> = {
      Title: event.title,
      Priority: PRIORITY[event.severity ?? 'info'],
      Tags: `${event.source},${event.type}`,
    }
    if (config.tokenEnv) headers.Authorization = `Bearer ${readSecret(env, config.tokenEnv)}`
    if (event.url) headers.Click = event.url
    await postRaw(url, event.body, { headers, fetch: fetchFn })
  },
}

export default sink
