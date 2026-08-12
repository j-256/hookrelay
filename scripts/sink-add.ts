import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser'
import {
  addDevVar,
  envSegment,
  prepareProduction,
  readOptionalText,
  readSecret,
  type SecretValue,
  writePrivateText,
} from './setup'
import { parseRoutes } from './sync'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const DISCORD_SINK_TYPE = 'discord'
const FORMATTING_OPTIONS: FormattingOptions = Object.freeze({ insertSpaces: true, tabSize: 2, eol: '\n' })

export interface SinkAddOptions {
  name: string
  type: string
  yes: boolean
}

interface DiscordSinkConfig {
  name: string
  type: typeof DISCORD_SINK_TYPE
  urlEnv: string
}

export interface PreparedSink {
  routesText: string
  devVarsText: string
  sink: DiscordSinkConfig
  secret: SecretValue
}

export function sinkAddUsage(): string {
  return [
    'usage: pnpm sink:add <name> discord [-y]',
    '',
    'options:',
    '  -y, --yes  apply remote changes without prompts',
    '  -h, --help show this help',
    '',
    'The Discord webhook URL is read from concealed input or stdin',
  ].join('\n')
}

export function parseSinkAddArgs(argv: string[]): SinkAddOptions {
  const positional: string[] = []
  let yes = false
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') yes = true
    else if (arg === '--help' || arg === '-h') throw new Error(sinkAddUsage())
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (positional.length !== 2) throw new Error(sinkAddUsage())
  const [name, type] = positional as [string, string]
  if (type !== DISCORD_SINK_TYPE) throw new Error(`unsupported sink type: ${type}; supported types: ${DISCORD_SINK_TYPE}`)
  return { name, type, yes }
}

export function normalizeDiscordWebhookUrl(value: string): string {
  const url = new URL(value)
  const host = url.hostname.toLowerCase()
  const isDiscordHost = host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com' || host.endsWith('.discordapp.com')
  if (url.protocol !== 'https:' || !isDiscordHost || !url.pathname.startsWith('/api/webhooks/')) {
    throw new Error('value is not an HTTPS Discord webhook URL')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Discord webhook URL contains unsupported components')
  return url.toString()
}

function updateRoutesText(text: string, sink: DiscordSinkConfig): string {
  let updated = applyEdits(
    text,
    modify(text, ['sinks', -1], sink, {
      isArrayInsertion: true,
      formattingOptions: FORMATTING_OPTIONS,
    }),
  )
  if (!updated.endsWith('\n')) updated += '\n'
  parseRoutes(updated)
  return updated
}

export function prepareDiscordSink(
  routesText: string,
  devVarsText: string,
  name: string,
  webhookUrl: string,
): PreparedSink {
  const routes = parseRoutes(routesText)
  if (routes.sinks.some((sink) => sink.name === name)) throw new Error(`sink already exists: ${name}`)

  const secretName = `SINK_${envSegment(name)}_URL`
  if (routes.sinks.some((sink) => Object.values(sink).includes(secretName))) {
    throw new Error(`sink secret name is already referenced: ${secretName}`)
  }
  const secret = { name: secretName, value: normalizeDiscordWebhookUrl(webhookUrl) }
  const sink: DiscordSinkConfig = { name, type: DISCORD_SINK_TYPE, urlEnv: secret.name }

  return {
    routesText: updateRoutesText(routesText, sink),
    devVarsText: addDevVar(devVarsText, secret.name, secret.value),
    sink,
    secret,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(sinkAddUsage())
    return
  }
  const options = parseSinkAddArgs(argv)
  const routesPath = resolve(ROUTES_FILE)
  const devVarsPath = resolve(DEV_VARS_FILE)
  const routesText = await readFile(routesPath, 'utf8')
  const devVarsText = await readOptionalText(devVarsPath)
  const webhookUrl = await readSecret('Discord webhook URL: ')
  const prepared = prepareDiscordSink(routesText, devVarsText, options.name, webhookUrl)

  await writeFile(routesPath, prepared.routesText, 'utf8')
  await writePrivateText(devVarsPath, prepared.devVarsText)
  console.log(`Prepared ${prepared.sink.type} sink ${prepared.sink.name}`)
  console.log(`Save the webhook URL in your secret store as ${prepared.secret.name}`)

  const production = await prepareProduction(prepared.secret, options.yes)
  if (production === 'local-only') {
    console.log(`Production was not changed; install ${prepared.secret.name} in Wrangler, then run pnpm sync and pnpm sync -y`)
  } else if (production === 'previewed') {
    console.log('The KV sink was not changed; run pnpm sync -y to apply it')
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
