# hookrelay

A small, extensible webhook receiver for Cloudflare Workers. Drop in adapters for new webhook senders (Statuspage, GitHub, your own scripts) and sinks for where notifications go (push, chat, log). Routing lives in KV, inbound bearer credentials are represented there by hashes, and recoverable credentials live in Wrangler secrets.

## What it does

Receives webhooks at `/hook/<source>/<slug>` from a configurable list of senders, normalizes the payload, persists every event to D1+R2, then queues one durable delivery per subscription sink (ntfy push, Discord channel, etc). Failed sink requests retry independently, and exhausted deliveries remain visible and manually retryable in the admin page.

Built-in adapters (v1):
- Statuspage incidents and scheduled maintenance (Atlassian)
- GitHub repo webhooks
- Cloudflare Notifications
- UptimeRobot

Built-in sinks (v1):
- ntfy.sh push (also self-hostable)
- Discord channel webhook

Admin: `/admin/events` (Cloudflare Access protected) for browsing recent events, inspecting per-sink delivery state, and retrying exhausted deliveries.

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
   npx wrangler queues create hookrelay-delivery
   npx wrangler queues create hookrelay-delivery-dlq
   ```
   Copy the printed ids into the `kv_namespaces` and `d1_databases` entries in `wrangler.jsonc`. These are opaque, account-scoped resource handles, not secrets – they grant no access without your API token, so they are safe to commit. Queue bindings use the two queue names directly, so keep those names aligned with `wrangler.jsonc`.

   > Note: Wrangler names the KV namespaces `hookrelay-SUBS` / `hookrelay-SINKS` (worker name + binding), so that is what shows in the dashboard. `SUBS`/`SINKS` are the *binding* names your code uses (`env.SUBS`); the `id` in `wrangler.jsonc` is what actually links them. Dashboard title and binding name differ by design.
3. Apply the D1 migration:
   ```sh
   npx wrangler d1 migrations apply hookrelay-events --remote
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
   npx wrangler secret put SINK_NTFY_PHONE_TOKEN
   npx wrangler secret put SINK_DISCORD_URL
   ```
6. Configure subscriptions and sinks. Copy `routes.example.jsonc` to `routes.jsonc`, fill in real values, and sync to KV:
   ```sh
   cp routes.example.jsonc routes.jsonc
   # generate hash-only config stubs and private webhook URLs
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
   Then in the Cloudflare dashboard, attach the Worker to a custom domain (`hooks.example.com`). The route is managed in the dashboard rather than in `wrangler.jsonc`, so no hostname is committed to source (`workers_dev` is `false` to keep the Worker off `*.workers.dev`).

   To deploy automatically on every push instead, connect the repo with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (Worker -> Settings -> Build): set the branch to `main`, leave the build command empty (TypeScript is bundled at deploy time, no build step), and set the deploy command to `npx wrangler deploy`. No build variables are needed – Builds runs in your account's context and infers the account automatically, so there is no `account_id` to set. Apply new D1 migrations before a build deploys code that depends on them.
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

### 1. `wrangler.jsonc` – committed, safe to make public

These are opaque, account-scoped *resource handles*. They name a resource but grant no access on their own: every Cloudflare API call still requires your API token, and a binding id from one account cannot be used from another. That is why they are safe to commit.

| Key | What it is |
| --- | --- |
| `kv_namespaces[].id` (`SUBS`, `SINKS`) | KV namespaces holding subscription and sink config |
| `d1_databases[].database_id` | D1 database storing the event log and subscription hashes |
| `r2_buckets[].bucket_name` | R2 bucket for raw payloads (bound by name, so there is no id to set) |
| `queues` | Producer and consumer bindings for per-sink delivery and its dead-letter queue |
| `triggers.crons` | Five-minute recovery sweep for delivery rows that could not be published to the queue |
| `observability` | Stored Workers Logs are disabled on purpose -- webhook URLs contain the slug (a bearer token) and Cloudflare enriches stored logs with the request URL, which would leak it. See the comment in the file; failure visibility comes from D1 (`/admin/events`) and `wrangler tail` instead. |

### 2. Environment variables – your shell, CI, or Workers Builds

Read by Wrangler at deploy time; never committed.

| Variable | What it is |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id. Kept in the environment (not `wrangler.jsonc`) so the committed config carries no account identifier. |
| `CLOUDFLARE_API_TOKEN` | Auth for `wrangler` / CI. Needs Workers, KV, D1, R2, Queues, and (for the WAF script) Zone WAF edit scopes. This is the credential everything else depends on – guard it. |

### 3. Wrangler secrets – recoverable only by Worker code

Set with `npx wrangler secret put <NAME>`. Wrangler lists their names but does not return their values, while Worker code can read the values when it needs to call an outbound service. Record them in your own password manager. For local `wrangler dev`, mirror them into a `.dev.vars` file (gitignored).

| Secret | What it is |
| --- | --- |
| `CF_ACCESS_TEAM_DOMAIN` | Your Zero Trust team subdomain (the part before `.cloudflareaccess.com`). Identifies your org, so it is a secret rather than a committed var. |
| `CF_ACCESS_AUD` | The AUD tag of the Access application protecting `/admin/*`. |
| `HMAC_<label>` | Per-subscription HMAC key for signed senders (e.g. GitHub). The name is your choice; it is referenced by `auth.secretEnv` in `routes.jsonc`. |
| `SINK_<name>_TOKEN` | Access token for an authenticated sink such as ntfy. Referenced by the sink's `tokenEnv` in `routes.jsonc`. |
| `SINK_<name>_URL` | A sink credential, such as a Discord webhook URL. Referenced by the sink's `urlEnv` in `routes.jsonc`. |

The names are a convention, not a requirement – whatever you put in `routes.jsonc` (`auth.secretEnv`, a sink's `tokenEnv` or `urlEnv`) must match a secret name you have set. `pnpm sync` validates that every referenced secret exists before it writes anything.

### 4. KV via `routes.jsonc` – synced with `pnpm sync`

`routes.jsonc` is your real subscription config. It contains a hash of each incoming slug, never the raw slug. It remains **gitignored** because some sink types, such as an unreserved ntfy topic, can still place bearer credentials there. `pnpm sync` validates the file and writes it into the `SUBS`/`SINKS` KV namespaces; the Worker reads only KV at runtime.

| Field | What it is |
| --- | --- |
| `subs[].slugHash` | Lowercase SHA-256 digest of the private slug. The Worker hashes the incoming path segment and uses `sub:sha256:<slugHash>` for KV lookup; neither KV nor this file needs the raw slug. Generate it with `pnpm new-sub` rather than choosing a low-entropy slug. |
| `subs[].source` | Adapter name (`statuspage`, `github`, `cloudflare-notifications`, `uptime`). |
| `subs[].sinks` | Names of sinks (from `sinks[]`) to fan out to. |
| `subs[].auth` | Optional `{ scheme, secretEnv }` for signature/secret verification on top of the slug. |
| `sinks[].type: ntfy` -> `topic` | **Bearer secret for unreserved topics.** Anyone who knows an unreserved topic can read its notifications. Use a long random topic and treat it like a password. |
| `sinks[].type: ntfy` -> `server` | Optional. Base URL of a self-hosted ntfy server; defaults to `https://ntfy.sh`. |
| `sinks[].type: ntfy` -> `tokenEnv` | Optional Wrangler secret name containing an ntfy access token. Strongly recommended for Cloudflare Workers so publishes use the account's quota instead of a shared anonymous egress-IP quota. Authentication does not make an unreserved topic private. |
| `sinks[].type: discord` -> `urlEnv` | Name of the Wrangler secret holding the Discord webhook URL (not the URL itself). |

The incoming slug and Discord webhook URL are both bearer secrets, but Hookrelay uses them differently. It hashes the slug because it only needs to recognize an incoming value. It keeps the Discord URL in a Worker secret because it must recover that value to make an outbound request. Guard generated webhook URLs, unreserved ntfy topics, and sink credentials in a password manager and keep them out of logs, screenshots, and commits.

## Adding a subscription

`routes.jsonc` is the complete desired state for subscriptions and sinks. Keep every existing entry when adding one: `pnpm sync --yes` removes remote KV entries that are absent from the file.

1. Add or reuse a sink in `routes.jsonc`. For Discord, put the webhook URL in a Wrangler secret and reference its name with `urlEnv`. For authenticated ntfy, keep the topic in `routes.jsonc`, put the access token in a Wrangler secret, and reference its name with `tokenEnv`.
2. Generate the subscription stub and webhook URL:
   ```sh
   pnpm new-sub <subscription-name> <source>
   ```
3. Save the printed webhook URL in a password manager, then paste the hash-only stub into `subs[]` and select its sink names. The URL contains the webhook password and cannot be recovered from `slugHash`.
4. Preview and apply the KV changes:
   ```sh
   pnpm sync
   pnpm sync --yes
   ```
5. Replace `hooks.example.com` in the saved URL with your hook domain, then paste the full URL into the provider's webhook subscription form. For providers with HMAC support, set the Wrangler secret first and add the matching `auth` block.
6. Send a fixture or wait for a real event, then confirm its sink moves from `queued` or `processing` to `delivered` at `/admin/events`.

Statuspage incident and scheduled-maintenance updates use the same `statuspage` subscription. No second hook is needed for maintenance.

## Durable delivery

The webhook request writes the event to D1 and R2 and creates one D1 delivery row per sink before returning `200`. It then publishes a compact queue message containing only the event ID, sink name, and delivery generation; the consumer reloads the normalized event from R2. A failure in one sink never resends a sink that already succeeded.

The primary queue retries failures with bounded exponential backoff and honors a valid HTTP `Retry-After` delay. After automatic retries are exhausted, Cloudflare moves the message to `hookrelay-delivery-dlq`, whose consumer marks the D1 row `exhausted`. That final D1 update also retries for the queue's retention window if D1 is unavailable. The Access-protected admin page exposes a retry button for that sink only.

If queue publication itself fails, the row remains `pending`. The Cron Trigger republishes pending rows every five minutes, so recovery does not depend on the webhook provider sending the event again. Every publication reserves a new generation first, which makes late messages from an uncertain earlier publish or manual-retry cycle harmless.

Delivery is at least once. The D1 claim and lease suppress ordinary duplicate queue messages, but a sink can still receive a duplicate if it accepts a request and the Worker stops before recording success. That tradeoff avoids silently losing the notification.

For an existing deployment that predates queues, the D1 migration imports old successful fanout results as `delivered` and old failures as `exhausted`. The Worker performs the same import lazily if it encounters an old event that was written after the migration. Roll out in this order so the Worker never references missing resources or schema:

```sh
npx wrangler queues create hookrelay-delivery
npx wrangler queues create hookrelay-delivery-dlq
npx wrangler d1 migrations apply hookrelay-events --remote
npx wrangler deploy
```

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

Expected: each returns `{"ok":true,"eventId":"..."}` after the event and delivery intent are durable. The event appears at `/admin/events`, normally moving from `queued` or `processing` to `delivered` within seconds.

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
- `src/router.ts` – request pipeline (slug parse, KV lookup, verify, parse, persist, enqueue)
- `src/delivery.ts` – D1 outbox, queue consumers, retries, dead-letter handling, and manual redrive
- `src/persistence.ts` – D1 idempotent insert plus R2 raw and normalized objects
- `src/fanout.ts` – validation and dispatch for one sink attempt
- `src/registry.ts` – the only place where adapters and sinks are wired in

## License

MIT. See LICENSE.

## Support

Best-effort. Issues and PRs welcome but not promised.
