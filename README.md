# hookrelay

A small, extensible webhook receiver for Cloudflare Workers. Drop in adapters for new webhook senders (Statuspage, GitHub, your own scripts) and sinks for where notifications go (push, chat, log). Subscriptions and routing live in KV; secrets live in Wrangler.

## What it does

Receives webhooks at `/hook/<source>/<slug>` from a configurable list of senders, normalizes the payload, persists every event to D1+R2, then fans out notifications to per-subscription sinks (ntfy push, Discord channel, etc).

Built-in adapters (v1):
- Statuspage (Atlassian)
- GitHub repo webhooks
- Cloudflare Notifications
- UptimeRobot

Built-in sinks (v1):
- ntfy.sh push (also self-hostable)
- Discord channel webhook

Admin: `/admin/events` (Cloudflare Access protected) for browsing recent events with filters.

## Deploy your own

You will need:
- A Cloudflare account on the Workers free plan or higher
- A custom domain on Cloudflare (the WAF rule and Cloudflare Access only work on a real zone, not `*.workers.dev`)
- Node 22 + pnpm 11
- Wrangler authenticated to your account (`npx wrangler login`)
- `CLOUDFLARE_ACCOUNT_ID` set in your environment (wrangler reads the account id from it, so it is not committed to `wrangler.jsonc`)

Steps:

1. Clone and install:
   ```sh
   git clone https://github.com/j-256/hookrelay.git
   cd hookrelay
   pnpm install
   ```
2. Create the Cloudflare resources (one-time):
   ```sh
   npx wrangler kv namespace create SUBS
   npx wrangler kv namespace create SINKS
   npx wrangler d1 create hookrelay-events
   npx wrangler r2 bucket create hookrelay-events-raw
   ```
   Copy the printed ids into the `kv_namespaces` and `d1_databases` entries in `wrangler.jsonc`. These are opaque, account-scoped resource handles, not secrets -- they grant no access without your API token, so they are safe to commit.

   > Note: Wrangler names the KV namespaces `hookrelay-SUBS` / `hookrelay-SINKS` (worker name + binding), so that is what shows in the dashboard. `SUBS`/`SINKS` are the *binding* names your code uses (`env.SUBS`); the `id` in `wrangler.jsonc` is what actually links them. Dashboard title and binding name differ by design.
3. Apply the D1 migration:
   ```sh
   npx wrangler d1 migrations apply hookrelay-events
   ```
4. Set the Cloudflare Access values as Wrangler **secrets** (they identify your Zero Trust org, so they are kept out of source):
   ```sh
   npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
   npx wrangler secret put CF_ACCESS_AUD
   ```
   - `CF_ACCESS_TEAM_DOMAIN`: your Zero Trust team subdomain -- the part before `.cloudflareaccess.com`. Find it in the Zero Trust dashboard under Settings, or run `npx wrangler access` (note: it may not match your org name -- e.g. an org named `my-org` can have the team domain `myorg`)
   - `CF_ACCESS_AUD`: the AUD tag from your CF Access application configured for `/admin/*`
   - For local `wrangler dev`, put both in a `.dev.vars` file (gitignored) instead.
5. Set Wrangler secrets for any HMAC senders and authenticated sinks. The names you choose go into `routes.jsonc`. The recommended convention is `HMAC_<sub-label>` for HMAC keys and `SINK_<name>_URL` / `SINK_<name>_TOKEN` for sink credentials:
   ```sh
   npx wrangler secret put HMAC_GITHUB_HOOKRELAY
   npx wrangler secret put SINK_DISCORD_PERSONAL_URL
   ```
6. Configure subscriptions and sinks. Copy `routes.example.jsonc` to `routes.jsonc`, fill in real values, and sync to KV:
   ```sh
   cp routes.example.jsonc routes.jsonc
   # generate slugs:
   pnpm new-sub claude-status statuspage
   pnpm new-sub github-yourname-yourrepo github
   # paste the printed entries into routes.jsonc, edit as needed, then:
   pnpm sync
   pnpm sync --yes  # to apply
   ```
7. Deploy the Worker:
   ```sh
   npx wrangler deploy
   ```
   Then in the Cloudflare dashboard, attach the Worker to a custom domain (`hooks.example.com`).
   The route is managed in the dashboard rather than in `wrangler.jsonc`, so no hostname is
   committed to source (`workers_dev` is `false` to keep the Worker off `*.workers.dev`).

   To deploy automatically on every push instead, connect the repo with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
   (Worker -> Settings -> Build): set the branch to `main`, leave the build command empty
   (TypeScript is bundled at deploy time, no build step), and set the deploy command to
   `npx wrangler deploy`. No build variables are needed -- Builds runs in your account's
   context and infers the account automatically, so there is no `account_id` to set.
8. (Optional) Deploy the edge WAF rule that keeps scanner traffic off the Worker:
   ```sh
   ./scripts/deploy-waf.sh hooks.example.com          # dry-run, shows the plan
   ./scripts/deploy-waf.sh hooks.example.com --apply   # deploy
   ```
   The default rule is a Free-plan-compatible default-deny: it edge-blocks every path that is
   not `/hook/*` or `/admin/*`, using the `starts_with` operator (allowed on all plans). A
   blocked request terminates at Cloudflare's edge and never invokes the Worker, so it does not
   count against the Workers request quota -- this is a cost optimization, not a correctness
   gate (the Worker already 404s unknown paths and 401s bad signatures on its own). `deploy-waf.sh`
   appends its rule by description and leaves any other rules in your custom ruleset untouched.
   See `scripts/waf-rules.example.jsonc` for the rule and the tradeoff it accepts.
9. Configure Cloudflare Access for `/admin/*` to require login (email OTP or GitHub OAuth, your choice). Note the AUD tag for step 4.
10. Smoke test (see "Smoke tests" below).

## Configuration reference

hookrelay splits configuration across four locations by sensitivity. The guiding rule: **nothing secret is committed.** If you are forking this to run your own instance, this section is the "what goes where, and why."

### 1. `wrangler.jsonc` -- committed, safe to make public

These are opaque, account-scoped *resource handles*. They name a resource but grant no access on their own: every Cloudflare API call still requires your API token, and a binding id from one account cannot be used from another. That is why they are safe to commit.

| Key | What it is |
| --- | --- |
| `kv_namespaces[].id` (`SUBS`, `SINKS`) | KV namespaces holding subscription and sink config |
| `d1_databases[].database_id` | D1 database storing the event log |
| `r2_buckets[].bucket_name` | R2 bucket for raw payloads (bound by name, so there is no id to set) |
| `observability` | Stored Workers Logs are disabled on purpose -- webhook URLs contain the slug (a bearer token) and Cloudflare enriches stored logs with the request URL, which would leak it. See the comment in the file; failure visibility comes from D1 (`/admin/events`) and `wrangler tail` instead. |

### 2. Environment variables -- your shell, CI, or Workers Builds

Read by Wrangler at deploy time; never committed.

| Variable | What it is |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id. Kept in the environment (not `wrangler.jsonc`) so the committed config carries no account identifier. |
| `CLOUDFLARE_API_TOKEN` | Auth for `wrangler` / CI. Needs Workers, KV, D1, and (for the WAF script) Zone WAF edit scopes. This is the credential everything else depends on -- guard it. |

### 3. Wrangler secrets -- encrypted, write-only

Set with `npx wrangler secret put <NAME>`. Cloudflare never displays them again after you set them, so record them in your own password manager. For local `wrangler dev`, mirror them into a `.dev.vars` file (gitignored).

| Secret | What it is |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team subdomain (the part before `.cloudflareaccess.com`). Identifies your org, so it is a secret rather than a committed var. |
| `CF_ACCESS_AUD` | The AUD tag of the Access application protecting `/admin/*`. |
| `HMAC_<label>` | Per-subscription HMAC key for signed senders (e.g. GitHub). The name is your choice; it is referenced by `auth.secretEnv` in `routes.jsonc`. |
| `SINK_<name>_URL` | A sink credential, such as a Discord webhook URL. Referenced by the sink's `urlEnv` in `routes.jsonc`. |

The names are a convention, not a requirement -- whatever you put in `routes.jsonc` (`auth.secretEnv`, a sink's `urlEnv`) must match a secret name you have set. `pnpm sync` validates that every referenced secret exists before it writes anything.

### 4. KV via `routes.jsonc` -- synced with `pnpm sync`

`routes.jsonc` is your real subscription config. It is **gitignored** (only `routes.example.jsonc` is tracked) because it contains bearer secrets. `pnpm sync` validates it and writes it into the `SUBS`/`SINKS` KV namespaces; the Worker reads only KV at runtime.

| Field | What it is |
| --- | --- |
| `subs[].slug` | **Bearer secret.** The unguessable path segment in `/hook/<source>/<slug>`. Anyone who learns it can post events as that subscription. Generate with `pnpm new-sub`; never log, commit, or share it. |
| `subs[].source` | Adapter name (`statuspage`, `github`, `cloudflare-notifications`, `uptime`). |
| `subs[].sinks` | Names of sinks (from `sinks[]`) to fan out to. |
| `subs[].auth` | Optional `{ scheme, secretEnv }` for signature/secret verification on top of the slug. |
| `sinks[].type: ntfy` -> `topic` | **Bearer secret.** ntfy has no auth beyond the topic name -- anyone who knows it can read your notifications. Use a long random topic, treat it like a password. |
| `sinks[].type: ntfy` -> `server` | Optional. Base URL of a self-hosted ntfy server; defaults to `https://ntfy.sh`. |
| `sinks[].type: discord` -> `urlEnv` | Name of the Wrangler secret holding the Discord webhook URL (not the URL itself). |

**Bearer secrets to guard:** subscription `slug`s and ntfy `topic`s. Both grant access purely by being known -- there is no second factor. Keep them in `routes.jsonc` (gitignored) and out of logs, screenshots, and commits.

## Smoke tests

After deploy, run each of these and check `/admin/events` to confirm. They are POSTs that mimic real webhook senders.

```sh
# Statuspage
curl -s -X POST -H 'content-type: application/json' \
  https://hooks.example.com/hook/statuspage/<your-statuspage-slug> \
  -d @test/fixtures/statuspage/incident-investigating.json

# GitHub (HMAC required) -- compute the signature first
BODY=$(cat test/fixtures/github/issues-opened.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$HMAC_GITHUB_HOOKRELAY" -hex | awk '{print $2}')
curl -s -X POST \
  -H 'content-type: application/json' \
  -H "x-github-event: issues" \
  -H "x-github-delivery: $(uuidgen)" \
  -H "x-hub-signature-256: sha256=$SIG" \
  https://hooks.example.com/hook/github/<your-github-slug> \
  -d "$BODY"

# Cloudflare Notifications
curl -s -X POST \
  -H 'content-type: application/json' \
  -H "cf-webhook-auth: $YOUR_CF_SECRET" \
  https://hooks.example.com/hook/cloudflare-notifications/<your-cf-slug> \
  -d @test/fixtures/cloudflare/ddos-start.json

# UptimeRobot
curl -s -X POST -H 'content-type: application/json' \
  https://hooks.example.com/hook/uptime/<your-uptime-slug> \
  -d @test/fixtures/uptime/down.json
```

Expected: each returns `{"ok":true,"eventId":"..."}` and the event appears at `/admin/events` within seconds.

## Writing an adapter

To support a new webhook source ("Linear"):

1. Create `src/adapters/linear.ts` exporting an `Adapter`:
   ```ts
   import type { Adapter } from '.'
   import type { NormalizedEvent, Subscription } from '../types'

   const adapter: Adapter = {
     sourceType: 'linear',
     async verify(req, raw, sub, env) {
       // implement signature verification or no-op if unsigned
     },
     async parse(req, raw, sub) {
       const payload = JSON.parse(new TextDecoder().decode(raw))
       return {
         source: 'linear',
         subName: sub.name,
         type: 'issue.created', // or whatever the event is
         id: payload.deliveryId, // or a content hash if Linear has no per-delivery id
         timestamp: payload.createdAt,
         title: payload.data.title,
         body: payload.data.description ?? '',
         url: payload.url,
         severity: 'info',
         raw: payload,
       }
     },
   }
   export default adapter
   ```
2. Add one line to `src/registry.ts`:
   ```ts
   import linear from './adapters/linear'
   // ...
   registerAdapter(linear)
   ```
3. Add the source name to `knownSources` in `scripts/sync.ts` (until that script learns to import from registry).
4. Write tests in `test/unit/adapters/linear.test.ts` -- see existing adapter tests for the shape.

## Writing a sink

To support a new destination ("Slack"):

1. Create `src/sinks/slack.ts`:
   ```ts
   import { z } from 'zod'
   import type { Sink } from '.'
   import { postJson } from '../lib/http'

   const configSchema = z.object({ urlEnv: z.string().min(1) }).strict()
   type Config = z.infer<typeof configSchema>

   const sink: Sink<Config> = {
     type: 'slack',
     configSchema,
     async send(event, config, env, fetchFn) {
       const url = (env as any)[config.urlEnv]
       if (!url) throw new Error(`slack webhook url not set: ${config.urlEnv}`)
       await postJson(url, { text: `*${event.title}*\n${event.body}` }, { fetch: fetchFn })
     },
   }
   export default sink
   ```
2. Add one line to `src/registry.ts`:
   ```ts
   import slack from './sinks/slack'
   // ...
   registerSink(slack)
   ```
3. Add the type to `knownSinkTypes` and the schema to `sinkSchemas` in `scripts/sync.ts`.
4. Tests in `test/unit/sinks/slack.test.ts`.

## Project layout

See `src/` for components and `test/` for unit and integration tests. Key files:
- `src/router.ts` -- request pipeline (slug parse, KV lookup, verify, parse, persist)
- `src/persistence.ts` -- D1 idempotent insert + R2 raw + sidecar
- `src/fanout.ts` -- parallel sink dispatch (always inside `ctx.waitUntil`)
- `src/registry.ts` -- the only place where adapters and sinks are wired in

## License

MIT. See LICENSE.

## Support

Best-effort. Issues and PRs welcome but not promised.
