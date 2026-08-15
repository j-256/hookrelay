import { GITHUB_EVENT_PROFILES } from './github-events'
import { KNOWN_SOURCE_TYPES } from './subscription-sources'

export function commandReference(): string {
  const sources = KNOWN_SOURCE_TYPES.join(', ')
  const githubProfiles = Object.keys(GITHUB_EVENT_PROFILES).sort().join(', ')

  return [
    'Hookrelay quick reference',
    '',
    'Guided setup',
    '  pnpm sink:add <name> <discord|webhook>',
    '      Add a Discord or signed generic webhook sink, then offer to install and sync it',
    '  pnpm sink:rename <old-name> <new-name>',
    '      Safely prepare, switch, and finalize a deployed sink rename',
    '  pnpm sink:secret:rename <sink> <old-secret> <new-secret>',
    '      Change one sink *Env reference without changing its delivery identity',
    '  pnpm sub:add <name> <source> [-s <sink>]',
    '      Add a subscription locally, then offer to install, sync, and configure it',
    '  pnpm sub:events <name> [-e <profiles>]',
    '      Update or reconcile an existing GitHub webhook event selection',
    '  pnpm github:fleet plan --root <directory> --manifest <file>',
    '      Audit public or explicitly selected private repositories and preview the three-hook fleet',
    '  pnpm github:fleet prepare --root <directory> --manifest <file>',
    '      Generate missing private values and update local desired state only',
    '  pnpm github:fleet apply --root <directory> --manifest <file> [production write]',
    '      Install HMACs, sync selected routes, and reconcile GitHub hooks',
    '  pnpm github:fleet verify --root <directory> --manifest <file>',
    '      Audit managed routes and hooks, including fresh nondelivering GitHub pings',
    '  pnpm sync',
    '      Preview routes.jsonc against production KV',
    '  pnpm sync -y                         [production write]',
    '      Apply the routes.jsonc plan to production KV',
    '',
    `Sources: ${sources}`,
    'sub:add options: -s/--sink, -b/--base-url, --fallback-url, --email-base, --allow-sender, --primary-link-label, -r/--repo, -e/--events, -y/--yes',
    'sub:events options: -e/--events, -y/--yes',
    'github:fleet options: --repo (repeatable), --include-private (requires --repo), --secret-limit, -y/--yes (apply only)',
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

if (import.meta.main) console.log(commandReference())
