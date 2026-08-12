import { randomBytes } from 'node:crypto'
import { hashSubscriptionSlug } from '../src/lib/subscription'

function slug(): string {
  return randomBytes(16).toString('base64url')
}

export async function createSubscription(name: string, source: string, generatedSlug = slug()) {
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
  const name = process.argv[2]
  const source = process.argv[3]
  if (!name || !source) {
    console.error('usage: pnpm new-sub <name> <source>')
    console.error('example: pnpm new-sub claude-status statuspage')
    process.exit(1)
  }

  const generated = await createSubscription(name, source)
  console.log(JSON.stringify(generated.stub, null, 2))
  console.error(`\nWebhook URL: ${generated.webhookUrl}`)
  console.error('Save this URL in a password manager. The slugHash in the config cannot recover it.')
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
