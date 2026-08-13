import { GITHUB_EVENT_PROFILES } from './github-events'
import { KNOWN_SOURCE_TYPES } from './subscription-sources'

export function commandReference(): string {
  const sources = KNOWN_SOURCE_TYPES.join(', ')
  const githubProfiles = Object.keys(GITHUB_EVENT_PROFILES).sort().join(', ')

  return [
    'Hookrelay quick reference',
    '',
    'Guided setup',
    '  pnpm sink:add <name> discord',
    '      Add a Discord sink locally, then offer to install and sync it',
    '  pnpm sink:rename <old-name> <new-name>',
    '      Safely prepare, switch, and finalize a deployed sink rename',
    '  pnpm sink:secret:rename <sink> <old-secret> <new-secret>',
    '      Change one sink *Env reference without changing its delivery identity',
    '  pnpm sub:add <name> <source> [-s <sink>]',
    '      Add a subscription locally, then offer to install, sync, and configure it',
    '  pnpm sub:events <name> [-e <profiles>]',
    '      Update or reconcile an existing GitHub webhook event selection',
    '  pnpm sync',
    '      Preview routes.jsonc against production KV',
    '  pnpm sync -y                         [production write]',
    '      Apply the routes.jsonc plan to production KV',
    '',
    `Sources: ${sources}`,
    'sub:add options: -s/--sink, -b/--base-url, -r/--repo, -e/--events, -y/--yes',
    'sub:events options: -e/--events, -y/--yes',
    'GitHub --events defaults to push; recommended and named profiles compose with commas',
    `GitHub profiles: ${githubProfiles}`,
    'GitHub all and manual selections are exclusive',
    '',
    'Develop and verify',
    '  pnpm dev                             Start the local Worker',
    '  pnpm test                            Run the test suite',
    '  pnpm test:watch                      Run tests in watch mode',
    '  pnpm typecheck                       Regenerate Worker types and check TypeScript',
    '',
    'Deploy',
    '  pnpm deploy                          Deploy Worker code [production write]',
    '',
    'Low-level',
    '  pnpm new-sub <name> <source>         Print a hash-only subscription stub',
    '',
    'Setup commands write local files before asking about production',
    '-y skips production confirmations; omit it when you want to review each step',
    'Use pnpm <command> -h for full command-specific options',
  ].join('\n')
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) console.log(commandReference())
