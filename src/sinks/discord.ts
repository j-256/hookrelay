import { z } from 'zod'
import type { Sink } from '.'
import type { Env } from '../index'
import { postJson } from '../lib/http'
import { readSecret } from '../lib/secret'
import type { NormalizedEvent, Severity } from '../types'

const COLOR: Record<Severity, number> = {
  debug: 0x99aab5,
  info: 0x3498db,
  warning: 0xfee75c,
  error: 0xed4245,
  critical: 0x8b0000,
}

const DISCORD_DESCRIPTION_LIMIT = 4096
const DISCORD_TITLE_LIMIT = 256

const configSchema = z
  .object({
    urlEnv: z.string().min(1),
  })
  .strict()

type Config = z.infer<typeof configSchema>

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

const sink: Sink<Config> = {
  type: 'discord',
  configSchema,

  async send(event: NormalizedEvent, config: Config, env: Env, _context, fetchFn?: typeof fetch) {
    const url = readSecret(env, config.urlEnv)
    const color = COLOR[event.severity ?? 'info']
    const payload = {
      username: 'hookrelay',
      embeds: [
        {
          title: truncate(event.title, DISCORD_TITLE_LIMIT),
          description: truncate(event.body, DISCORD_DESCRIPTION_LIMIT),
          url: event.url,
          color,
          timestamp: event.timestamp,
          footer: { text: `${event.source} / ${event.subName} / ${event.type}` },
        },
      ],
    }
    await postJson(url, payload, { fetch: fetchFn })
  },
}

export default sink
