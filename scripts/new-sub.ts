import { parseArgs } from 'node:util'
import { savePrivateSubscriptionSetup } from './subscription-private-output'
import { randomBytes } from 'node:crypto'
import { EMAIL_SOURCE } from '../src/lib/email-address'
import { hashSubscriptionSlug } from '../src/lib/subscription'
const GENERATOR_USAGE =
  'usage: pnpm new-sub <name> <source> [-o|--private-export <new-private-file>]'
function invalidGeneratorOptions(): never {
  throw Object.assign(new Error(GENERATOR_USAGE), { code: 'validation' })
}

function slug(): string {
  return randomBytes(16).toString('base64url')
}

export async function createSubscription(name: string, source: string, generatedSlug = slug()) {
  if (source === EMAIL_SOURCE) {
    throw new Error('email subscriptions require pnpm sub:add with --email-base')
  }
  return {
    stub: {
      name,
      source,
      slugHash: await hashSubscriptionSlug(generatedSlug),
      enabled: true,
      sinks: ['discord'],
    },
    webhookUrl: `https://hooks.example.com/hook/${source}/${generatedSlug}`,
  }
}

async function main() {
  const { values, positionals, tokens } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'private-export': { type: 'string', short: 'o' },
    },
  })
  if (values.help) {
    console.log(GENERATOR_USAGE)
    return
  }
  const seen = new Set<string>()
  for (const token of tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name) || token.value === '' || token.value?.startsWith('-'))
        invalidGeneratorOptions()
      seen.add(token.name)
    }
  if (positionals.length !== 2) invalidGeneratorOptions()
  const [name, source] = positionals as [string, string]
  const generated = await createSubscription(name, source)
  const recoveryFile = await savePrivateSubscriptionSetup(
    { name, source, subscription: generated.stub, webhookUrl: generated.webhookUrl },
    values['private-export'],
  )
  console.log(JSON.stringify(generated.stub, null, 2))
  console.error('Private receiver recovery saved to: ' + recoveryFile)
}

if (import.meta.main) {
  main().catch((err) => {
    const code=err && typeof err==='object' && 'code' in err ? String(err.code) : ''
    const usage=code==='validation' || code.startsWith('ERR_PARSE_ARGS')
    console.error(usage ? GENERATOR_USAGE : 'Subscription generation failed; check source, arguments and protected output custody')
    process.exitCode=usage ? 2 : code==='ENOENT' ? 3 : 1
  })
}
