import { randomBytes } from 'node:crypto'

const name = process.argv[2]
const source = process.argv[3]
if (!name || !source) {
  console.error('usage: pnpm new-sub <name> <source>')
  console.error('example: pnpm new-sub claude-status statuspage')
  process.exit(1)
}

function slug(): string {
  return randomBytes(16).toString('base64url')
}

const stub = {
  name,
  source,
  slug: slug(),
  enabled: true,
  sinks: ['phone'],
}

console.log(JSON.stringify(stub, null, 2))
console.error(`\nGenerated slug. Webhook URL: https://hooks.example.com/hook/${source}/${stub.slug}`)
