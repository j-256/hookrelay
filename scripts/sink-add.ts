import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
  writeText,
} from './setup'
import { parseRoutes } from './sync'
import { normalizeWebhookEndpointUrl } from '../src/lib/public-url'

const ROUTES_FILE = 'routes.jsonc'
const DEV_VARS_FILE = '.dev.vars'
const DISCORD_SINK_TYPE = 'discord'
const WEBHOOK_SINK_TYPE = 'webhook'
const SUPPORTED_SINK_TYPES = [DISCORD_SINK_TYPE, WEBHOOK_SINK_TYPE] as const
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

interface WebhookSinkConfig {
  name: string
  type: typeof WEBHOOK_SINK_TYPE
  urlEnv: string
  signingSecretEnv: string
}

type PreparedSinkConfig = DiscordSinkConfig | WebhookSinkConfig

export interface PreparedSink {
  routesText: string
  devVarsText: string
  sink: PreparedSinkConfig
  secret: SecretValue
  secrets: SecretValue[]
}

export function sinkAddUsage(): string {
  return [
    'usage: pnpm sink:add <name> <discord|webhook> [-y]',
    '',
    'options:',
    '  -y, --yes  apply remote changes without prompts',
    '  -h, --help show this help',
    '',
    'The destination URL is read from concealed input or stdin',
    'Webhook sinks generate a separate outbound signing secret',
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
  if (!SUPPORTED_SINK_TYPES.includes(type as typeof SUPPORTED_SINK_TYPES[number])) {
    throw new Error(`unsupported sink type: ${type}; supported types: ${SUPPORTED_SINK_TYPES.join(', ')}`)
  }
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

function updateRoutesText(text: string, sink: PreparedSinkConfig): string {
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
  const configuredSinks = [...routes.sinks, ...(routes.retiredSinks ?? [])]
  if (configuredSinks.some((sink) => sink.name === name)) throw new Error(`sink already exists: ${name}`)

  const secretName = `SINK_${envSegment(name)}_URL`
  if (configuredSinks.some((sink) => Object.values(sink).includes(secretName))) {
    throw new Error(`sink secret name is already referenced: ${secretName}`)
  }
  const secret = { name: secretName, value: normalizeDiscordWebhookUrl(webhookUrl) }
  const sink: DiscordSinkConfig = { name, type: DISCORD_SINK_TYPE, urlEnv: secret.name }

  return {
    routesText: updateRoutesText(routesText, sink),
    devVarsText: addDevVar(devVarsText, secret.name, secret.value),
    sink,
    secret,
    secrets: [secret],
  }
}

export function prepareWebhookSink(
  routesText: string,
  devVarsText: string,
  name: string,
  endpointUrl: string,
  generatedSigningSecret = randomBytes(32).toString('hex'),
): PreparedSink {
  const routes = parseRoutes(routesText)
  const configuredSinks = [...routes.sinks, ...(routes.retiredSinks ?? [])]
  if (configuredSinks.some((sink) => sink.name === name)) throw new Error(`sink already exists: ${name}`)

  const label = envSegment(name)
  const urlSecret: SecretValue = {
    name: `SINK_${label}_URL`,
    value: normalizeWebhookEndpointUrl(endpointUrl),
  }
  const signingSecret: SecretValue = {
    name: `SINK_${label}_SIGNING_SECRET`,
    value: generatedSigningSecret,
  }
  if (!signingSecret.value) throw new Error('generated webhook signing secret is empty')
  const referencedValues = configuredSinks.flatMap((sink) => Object.values(sink))
  for (const secret of [urlSecret, signingSecret]) {
    if (referencedValues.includes(secret.name)) {
      throw new Error(`sink secret name is already referenced: ${secret.name}`)
    }
  }
  const sink: WebhookSinkConfig = {
    name,
    type: WEBHOOK_SINK_TYPE,
    urlEnv: urlSecret.name,
    signingSecretEnv: signingSecret.name,
  }
  const withUrl = addDevVar(devVarsText, urlSecret.name, urlSecret.value)
  return {
    routesText: updateRoutesText(routesText, sink),
    devVarsText: addDevVar(withUrl, signingSecret.name, signingSecret.value),
    sink,
    secret: urlSecret,
    secrets: [urlSecret, signingSecret],
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
  const endpointUrl = await readSecret(
    options.type === DISCORD_SINK_TYPE ? 'Discord webhook URL: ' : 'Webhook endpoint URL: ',
  )
  const prepared = options.type === DISCORD_SINK_TYPE
    ? prepareDiscordSink(routesText, devVarsText, options.name, endpointUrl)
    : prepareWebhookSink(routesText, devVarsText, options.name, endpointUrl)

  await writeText(routesPath, prepared.routesText)
  await writePrivateText(devVarsPath, prepared.devVarsText)
  console.log(`Prepared ${prepared.sink.type} sink ${prepared.sink.name}`)
  if (prepared.sink.type === DISCORD_SINK_TYPE) {
    console.log(`Save the webhook URL in your secret store as ${prepared.secret.name}`)
  } else {
    const [urlSecret, signingSecret] = prepared.secrets
    console.log(`Save the endpoint URL in your secret store as ${urlSecret!.name}`)
    console.log(`Save the generated signing secret as ${signingSecret!.name}=${signingSecret!.value}`)
  }

  const production = await prepareProduction(prepared.secrets, options.yes)
  if (production === 'local-only') {
    console.log(`Production was not changed; install ${prepared.secrets.map((secret) => secret.name).join(', ')} in Wrangler, then run pnpm sync and pnpm sync -y`)
  } else if (production === 'previewed') {
    console.log('The KV sink was not changed; run pnpm sync -y to apply it')
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
