# hookrelay

Run `pnpm commands` for a one-screen reference to routine setup, sync, development, and deployment commands.

A small, extensible notification receiver for Cloudflare Workers. Drop in adapters for new webhook senders (Statuspage, GitHub, your own scripts), receive ordinary email, and route normalized updates to sinks such as push, chat, or logs. Routing lives in KV, inbound bearer credentials are represented there by hashes, and recoverable credentials live in Wrangler secrets.

## What it does

Receives webhooks at `/hook/<source>/<slug>` or MIME email through Cloudflare Email Routing, normalizes the payload, persists every event to D1+R2, then queues one durable delivery per subscription sink (ntfy push, Discord channel, etc). Failed sink requests retry independently, and exhausted deliveries remain visible and manually retryable in the admin page.

Built-in sources (v1):
- Statuspage incidents and scheduled maintenance (Atlassian)
- GitHub repo webhooks
- Cloudflare Notifications
- UptimeRobot
- Generic email, including multipart plain text and HTML messages

Built-in sinks (v1):
- ntfy.sh push (also self-hostable)
- Discord channel webhook

Admin: `/admin` redirects to the Cloudflare Access-protected `/admin/events` dashboard for browsing recent events, inspecting per-sink delivery state, and retrying exhausted deliveries.

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
   cp wrangler.example.jsonc wrangler.jsonc
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
   Copy the printed ids into the `kv_namespaces` and `d1_databases` entries in the ignored `wrangler.jsonc`. These are opaque resource handles rather than credentials, but keeping the deployment config local avoids publishing account-specific identifiers. Queue bindings use the two queue names directly, so keep those names aligned with `wrangler.jsonc`.

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
5. Initialize the local routing config:
   ```sh
   cp routes.example.jsonc routes.jsonc
   ```
6. Deploy the Worker:
   ```sh
   npx wrangler deploy
   ```
   Then in the Cloudflare dashboard, attach the Worker to a custom domain (`hooks.example.com`). The route is managed in the dashboard rather than in `wrangler.jsonc`, so no hostname is committed to source (`workers_dev` is `false` to keep the Worker off `*.workers.dev`).

   To deploy automatically on every push instead, connect the repo with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) (Worker -> Settings -> Build). Store the completed `wrangler.jsonc` as a masked `HOOKRELAY_WRANGLER_CONFIG` build secret, set the build command to `printf '%s' "$HOOKRELAY_WRANGLER_CONFIG" > wrangler.jsonc && pnpm typecheck && pnpm test`, and set the deploy command to `npx wrangler deploy`. Workers Builds exposes configured build secrets only to the build, and runs the build command before the deploy command, so the private config is available for deployment without entering Git history. Apply new D1 migrations before a build deploys code that depends on them.
7. Add a sink. The command reads the Discord webhook URL without echoing it, stores it in `.dev.vars`, adds the secret reference to `routes.jsonc`, and offers to install the Wrangler secret and sync KV:
   ```sh
   pnpm sink:add discord discord
   ```
8. Add subscriptions. Each command writes the hash-only route locally, prints the raw slug under a password-manager key, and offers to install any sender secret and sync KV. GitHub's non-manual event selections create the repository webhook only after the route is live:
   ```sh
   pnpm sub:add claude-status statuspage
   pnpm sub:add github-yourname-yourrepo github --repo yourname/yourrepo --events activity,alerts
   pnpm sub:add openai-status email --email-base relay@mail.example.com
   ```
   Email subscriptions require the one-time Email Routing setup described in [Forwarding email notifications](#forwarding-email-notifications).
9. (Optional) Deploy the edge WAF rule that keeps scanner traffic off the Worker:
   ```sh
   ./scripts/deploy-waf.sh hooks.example.com          # dry-run, shows the plan
   ./scripts/deploy-waf.sh hooks.example.com --apply   # deploy
   ```
   The default rule is a Free-plan-compatible default-deny: it edge-blocks every path that is not `/hook/*`, `/admin`, or `/admin/*`, using operators allowed on all plans. A blocked request terminates at Cloudflare's edge and never invokes the Worker, so it does not count against the Workers request quota -- this is a cost optimization, not a correctness gate (the Worker already 404s unknown paths and 401s bad signatures on its own). `deploy-waf.sh` appends its rule by description and leaves any other rules in your custom ruleset untouched. See `scripts/waf-rules.example.jsonc` for the rule and the tradeoff it accepts.
10. Configure Cloudflare Access for `/admin/*` to require login (email OTP or GitHub OAuth, your choice). Note the AUD tag for step 4.
11. Smoke test (see "Smoke tests" below).

## Configuration reference

hookrelay separates configuration by sensitivity. The guiding rule: **nothing secret or deployment-specific is committed.** If you are forking this to run your own instance, this section is the "what goes where, and why."

### 1. `wrangler.example.jsonc` and `wrangler.jsonc`

`wrangler.example.jsonc` is the committed template with placeholder binding ids. Copy it to the ignored `wrangler.jsonc` and insert the resource handles for your deployment. The handles grant no access on their own, but the private copy keeps account-specific identifiers out of source history.

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
| `baseUrl` | Optional public Worker origin used by `pnpm sub:add` to construct provider webhook URLs. Without it, the command discovers the single production custom domain attached to the Worker through Cloudflare's API and saves the result here. This local setup value is not written to KV. |
| `emailBaseAddress` | Base address for Cloudflare Email Routing, such as `relay@mail.example.com`. `pnpm sub:add` appends a private plus-address route token. This local setup value is not written to KV. |
| `subs[].slugHash` | Lowercase SHA-256 digest of the private slug. The Worker hashes the incoming path segment and uses `sub:sha256:<slugHash>` for KV lookup; neither KV nor this file needs the raw slug. Generate it with `pnpm sub:add` rather than choosing a low-entropy slug. |
| `subs[].source` | Source name (`statuspage`, `github`, `cloudflare-notifications`, `uptime`, `email`). |
| `subs[].sinks` | Names of sinks (from `sinks[]`) to fan out to. |
| `subs[].auth` | Optional `{ scheme, secretEnv }` for signature/secret verification on top of the slug. |
| `subs[].email.allowedSenders` | Optional email noise filter containing exact mailboxes or exact domains written as `@example.com`. Both the SMTP envelope sender and parsed `From`/`Sender` identities must match when the list is nonempty. |
| `subs[].setup` | Local-only provider setup metadata, including a GitHub repository and event profile names. `pnpm sync` validates it but does not write it to KV. |
| `sinks[].type: ntfy` -> `topic` | **Bearer secret for unreserved topics.** Anyone who knows an unreserved topic can read its notifications. Use a long random topic and treat it like a password. |
| `sinks[].type: ntfy` -> `server` | Optional. Base URL of a self-hosted ntfy server; defaults to `https://ntfy.sh`. |
| `sinks[].type: ntfy` -> `tokenEnv` | Optional Wrangler secret name containing an ntfy access token. Strongly recommended for Cloudflare Workers so publishes use the account's quota instead of a shared anonymous egress-IP quota. Authentication does not make an unreserved topic private. |
| `sinks[].type: discord` -> `urlEnv` | Name of the Wrangler secret holding the Discord webhook URL (not the URL itself). |

Incoming HTTP slugs, email plus-route tokens, and Discord webhook URLs are bearer values, but Hookrelay uses them differently. It hashes route tokens because it only needs to recognize an incoming value. It keeps the Discord URL in a Worker secret because it must recover that value to make an outbound request. Guard generated webhook URLs and email addresses, unreserved ntfy topics, and sink credentials in a password manager and keep them out of logs, screenshots, and commits.

## Guided setup lifecycle

`sink:add` and `sub:add` follow this order:

1. Read and validate gitignored `routes.jsonc` and `.dev.vars`. `sink:add` reads the Discord URL through concealed input. `sub:add` generates its private values and resolves the HTTP origin or email base address for the selected source.
2. Write the local desired state. Routing and hash-only subscription data go to `routes.jsonc`; Worker-readable secrets go to `.dev.vars`, which is kept at mode `600`. The commands do not populate Miniflare's local KV.
3. Print anything that belongs in your password manager. In particular, the raw incoming slug is not added to `.dev.vars`, because the Worker only needs its hash.
4. Ask before changing production. Approval installs any new Wrangler secret, then runs `pnpm sync` to compare `routes.jsonc` with remote Worker KV.
5. Ask whether to apply that plan. Approval runs `pnpm sync -y` to update remote KV.
6. For a non-manual GitHub selection, ask whether to create the repository webhook. This only happens after the remote sender secret and subscription route are live.

If every prompt is approved, no later sync is needed. Declining a production prompt or encountering a remote error leaves the completed local files in place. Install any deferred Wrangler secret, preview with `pnpm sync`, and apply with `pnpm sync -y`. Those commands finish Worker state only; if automatic GitHub hook creation was skipped, create the hook manually from the fields printed by `sub:add`. Passing `-y` or `--yes` skips the approvals but keeps the same local-first order.

## Adding a sink

`pnpm sink:add <name> discord` is the guided Discord path. It reads the webhook URL from concealed input, validates that it is a Discord webhook, derives `SINK_<NAME>_URL`, appends a sink containing only that secret reference to `routes.jsonc`, and mirrors the URL into the gitignored `.dev.vars`. It then offers to install the same value as a Wrangler secret, preview the KV plan, and apply it.

The sink name is a stable routing label, not a description of what feeds it. `discord` is a sensible first name. If several Discord destinations exist, names such as `discord-personal` and `discord-builds` produce independent `SINK_DISCORD_PERSONAL_URL` and `SINK_DISCORD_BUILDS_URL` secrets. Subscriptions refer to these names and remain independent of the sink implementation.

The command refuses to replace an existing sink or secret. The raw Discord URL never enters `routes.jsonc`, KV, process arguments, or command output. Save it in your password manager under the derived key printed by the command.

Pass `-y` or `--yes` to skip the production confirmation prompts. The URL is still read through concealed input when interactive, or from stdin for automation.

### Renaming a deployed sink

A deployed sink name is both a routing label and a delivery identity, so renaming it in one `routes.jsonc` edit can orphan queue messages that still carry the old name. Use the phased rename command instead:

```sh
pnpm sink:rename discord discord-service-status
pnpm sink:rename discord discord-service-status --switch
pnpm sink:rename discord discord-service-status --finalize
```

The prepare phase copies convention-derived local credentials such as `SINK_DISCORD_URL` to `SINK_DISCORD_SERVICE_STATUS_URL`, installs the new Wrangler secret after confirmation, and deploys both sink names with the new secret reference. Subscription routes still use the old name during this phase.

The switch phase verifies both remote sink aliases and the new secret before changing every subscription reference to the new name. The old alias remains deployed and uses the new secret, so already queued deliveries and historical admin retries continue to work.

The finalize phase explicitly deletes the obsolete local and Wrangler secret. It does not delete the old sink alias because doing so would break historical retries. Custom secret names that do not follow the `SINK_<NAME>_<CONCEPT>` convention remain unchanged.

Each phase accepts `-y` or `--yes` to apply its production changes without confirmation. Run the phases separately and let the prepare change propagate before switching subscription routes because [Workers KV reads are eventually consistent](https://developers.cloudflare.com/kv/concepts/how-kv-works/).

### Renaming a sink secret reference

Changing a sink's `urlEnv`, `tokenEnv`, or another `*Env` field does not require changing the sink name. Use the secret rename command with the existing sink name and the old and new Wrangler secret names:

```sh
pnpm sink:secret:rename discord SINK_DISCORD_URL SINK_DISCORD_SERVICE_STATUS_URL
pnpm sink:secret:rename discord SINK_DISCORD_URL SINK_DISCORD_SERVICE_STATUS_URL --finalize
```

The prepare phase copies the value from `.dev.vars`, installs the new Wrangler secret, and then syncs the selected sink's KV config to reference it. The old secret remains available while cached copies of the previous KV value expire, so queued messages carrying the unchanged sink name can dispatch through either configuration.

After the KV change has propagated, the explicit finalize phase verifies that production matches the new local sink config and that no route references the old secret before deleting it from Wrangler and `.dev.vars`. Sink names, subscription routes, queued delivery identities, and historical retry links do not change.

## Adding a subscription

`routes.jsonc` is the complete desired state for subscriptions and sinks. Keep every existing entry when adding one: `pnpm sync -y` removes remote KV entries that are absent from the file.

Run the guided command after the destination sink exists:

```sh
pnpm sub:add <subscription-name> <source> [-s <sink-name>]
```

If exactly one sink exists, it is selected automatically. Repeat `-s` or `--sink` to route to several sinks. The command generates a private incoming slug, stores only its SHA-256 hash in `routes.jsonc`, and prints the raw slug as `SUB_<NAME>_SLUG` for your password manager. Signed providers also get a per-subscription sender secret, mirrored into `.dev.vars` and offered to Wrangler. Production changes are previewed and confirmed unless `-y` or `--yes` is supplied.

`sub:add` also accepts `-b` for `--base-url`, `--email-base` for an Email Routing address, repeated `--allow-sender` filters, `-r` for `--repo`, and `-e` for `--events`. Run any setup command with `-h` or `--help` for its complete usage.

For a GitHub repository, pass the repository separately instead of deriving it from the subscription name. Subscription names may still use a readable namespace such as `github:example-owner/example-repo`:

```sh
pnpm sub:add github:example-owner/example-repo github --repo example-owner/example-repo --events stars,watchers
```

The `--events` value accepts comma-separated profiles. Profiles compose by set union, so `activity,alerts` combines concise repository activity with actionable security findings and `recommended,stars` adds star activity to the broad general-purpose set. `push` remains the default, while `all` and `manual` are exclusive presets. The complete profile-to-event table and noise guidance live in [GitHub event profiles](docs/github-event-profiles.md).

The base URL resolves from an explicit `--base-url`, then the value already saved in `routes.jsonc`, then the single production custom domain attached to the Worker named in `wrangler.jsonc`. Automatic discovery uses `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; an absent or ambiguous domain produces an error asking for `--base-url`.

With `manual`, use the printed payload URL and sender secret, choose JSON content, and keep SSL verification enabled. In every other selection, the command checks for an existing hook with the same URL and creates the hook through authenticated `gh` only after the Worker secret and KV route are live.

### Forwarding email notifications

Email ingress is provider-independent. Hookrelay parses MIME with `postal-mime`, prefers a `text/plain` body, converts HTML-only bodies to safe plain text without loading remote content, stores the untouched MIME message in R2, and sends the normalized subject, body, timestamp, and first HTTP link through the same sink pipeline as webhooks. Attachment metadata is retained, but attachment content is not sent to sinks. The Worker rejects a raw message larger than 1 MiB, including attachments. Generated email routes use 128-bit lowercase hexadecimal tokens, and the Worker normalizes incoming token case because mailbox providers may lowercase recipient addresses.

Cloudflare setup is one-time:

1. Deploy this Worker, then open Compute > Email Service > Email Routing in the Cloudflare dashboard. Onboard the zone or, preferably, [add a dedicated routing subdomain](https://developers.cloudflare.com/email-service/configuration/subdomains/) such as `mail.example.com` so existing apex-domain mail remains untouched.
2. In Email Routing > Settings, enable [subaddressing](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/#subaddressing).
3. In Routing Rules, create the base address, such as `relay@mail.example.com`, choose `Send to a Worker`, and select the Hookrelay Worker. One rule handles every generated `relay+<route>@mail.example.com` address because Cloudflare preserves the plus detail in `message.to`.
4. Add and sync a subscription, then paste the printed email address into the provider's email subscription form:

   ```sh
   pnpm sub:add openai-status email --email-base relay@mail.example.com
   ```

This works for OpenAI status notifications without knowing their template in advance. The parser handles multipart encodings generically, and the provider's confirmation message follows the same path to Discord or another selected sink.

If the provider's sender identity is already known, add one or more exact mailboxes or exact domains:

```sh
pnpm sub:add service-status email --email-base relay@mail.example.com \
  --allow-sender notifications@example.com \
  --allow-sender @mailer.example.com
```

If the identity is not documented, omit the allowlist. `View raw` in `/admin/events` exposes the original headers when troubleshooting, while the normalized R2 object records the envelope sender. Add filters only after confirming every legitimate identity, then run `pnpm sync` and `pnpm sync -y`. The allowlist is a noise filter, not cryptographic authentication: the documented [Email Worker message interface](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/) exposes envelope fields, headers, and raw MIME, but no verified SPF or DKIM result.

Treat each generated address as a bearer route. Cloudflare preserves the full plus address in Email Routing activity logs, and Hookrelay's protected raw MIME contains the recipient plus any confirmation or unsubscribe links. Hookrelay does not copy the route token into D1, normalized R2 objects, queue messages, or its own logs. Restrict access to the Cloudflare account, R2 bucket, admin page, and destination sink accordingly.

### Updating GitHub event profiles

Use the saved subscription name to replace an existing webhook's event selection:

```sh
pnpm sub:events github:example-owner/example-repo --events recommended,stars
```

The command updates only `setup.github.eventProfiles` in local `routes.jsonc`, preserving its comments, then finds the exact repository hook by hashing each Hookrelay URL slug and comparing it with the subscription's saved `slugHash`. It previews the GitHub change and asks before applying it; pass `-y` or `--yes` to skip that confirmation. Neither the private URL nor its slug is printed.

If you edit `eventProfiles` in `routes.jsonc` yourself, omit `--events` to reconcile that saved selection:

```sh
pnpm sub:events github:example-owner/example-repo
```

GitHub may return the same events in a different order, so order alone does not trigger an update. GitHub's general webhook update clears an existing secret unless the request supplies it again, so the command requires the subscription's `auth.secretEnv` value in `.dev.vars` and resends it with the unchanged URL, content type, SSL setting, and active state. The secret-bearing request travels through stdin and is never placed in process arguments or output. Selecting `manual` changes local metadata but leaves GitHub's checkboxes under manual control.

### Managing a GitHub repository fleet

`github:fleet` discovers public GitHub repositories checked out as immediate children of a supplied root and manages a standard three-hook topology for each repository. Activity uses the bare `github:<owner>/<repo>` subscription name and the `activity` event profile, stars uses the `:stars` suffix and `stars,watchers`, and alerts uses the `:alerts` suffix and `alerts`. Each profile routes to its configured fleet sink. The three hooks have distinct private URLs but share one per-repository HMAC.

The command requires an explicit manifest path so a deployment can choose its own encrypted or otherwise access-controlled secret store without embedding that location in Hookrelay. The JSON manifest is the recovery source for each repository's raw slugs and HMAC. It and `.dev.vars` must be regular, non-symlink files with mode `0600`; `routes.jsonc` stores only slug hashes. Treat the manifest and full GitHub hook URLs as secrets and never commit the manifest unless the repository encrypts it before storage.

The manifest is strict, versioned JSON with this repository shape:

```json
{
  "version": 1,
  "repositories": {
    "owner/repo": {
      "hmac": {
        "name": "HMAC_GITHUB_OWNER_REPO",
        "value": "<secret>"
      },
      "slugs": {
        "activity": "<private-slug>",
        "stars": "<private-slug>",
        "alerts": "<private-slug>"
      }
    }
  }
}
```

Preparation writes missing entries and refuses unknown fields, malformed values, or conflicts with existing recovery data.

Use the four phases in order:

```sh
pnpm github:fleet plan --root <directory> --manifest <file>
pnpm github:fleet prepare --root <directory> --manifest <file>
pnpm github:fleet apply --root <directory> --manifest <file>
pnpm github:fleet verify --root <directory> --manifest <file>
```

`plan` is read-only. It reports discoveries, exclusions, drift, exact additions, GitHub administration blockers, remote KV differences, and projected Worker variable and secret capacity. `prepare` is local-only: it generates missing manifest values first, then repairs `.dev.vars` and appends missing routes from that manifest. `apply` confirms before production writes, installs missing repository HMACs with Wrangler's [bulk secret command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk), updates only selected subscription and sink KV entries, waits for authenticated routes, and creates or repairs only Hookrelay-owned GitHub hooks. `verify` reports drift without repairing it, but it deliberately sends a fresh GitHub ping to every managed hook so it can prove the unrecoverable GitHub-side secret agrees with Hookrelay. Ping events are accepted without creating sink deliveries.

Repeat `--repo <owner/repo>` to limit new additions for a canary rollout. Already managed repositories are still audited. Omit `--repo` to select every eligible discovered repository. `--secret-limit` sets the capacity guard, and `-y` is accepted only by `apply` to skip its confirmation.

The workflow is additive-only: it does not prune unmanaged hooks, stale manifest entries, routes, or secrets. Reruns reuse manifest values, recognize hooks by the saved slug hash, and resume after a partial route or hook operation without duplicating a successful POST.

Route changes account for [Workers KV eventual consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/). Apply verifies the central value, probes the public route, and waits through a propagation grace period before creating or updating hooks. Wrangler bulk input is sent through stdin, secret values and raw slugs are not printed, and omitted secrets remain unchanged.

`pnpm new-sub <name> <source>` remains available as a low-level generator for HTTP sources. It only prints a hash-only stub and private URL; it intentionally does not modify local files, Wrangler secrets, KV, or provider hooks. Email sources require `pnpm sub:add` because their route also needs a base address and email-specific configuration.

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

Expected for each webhook command: it returns `{"ok":true,"eventId":"..."}` after the event and delivery intent are durable. The event appears at `/admin/events`, normally moving from `queued` or `processing` to `delivered` within seconds.

For email, send a message to the address printed by `pnpm sub:add`, or complete a provider's email-subscription confirmation flow. If an allowlist is active, send from an allowed identity. Email has no HTTP response to inspect; the event should appear with source `email` and type `email.received`.

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
3. Add an HTTP transport profile and any sender-authentication scheme to `scripts/subscription-sources.ts`.
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
- `src/email.ts` – MIME parsing, sender filtering, email normalization, and routing
- `src/ingest.ts` – shared durable persistence and delivery preparation for HTTP and email
- `src/delivery.ts` – D1 outbox, queue consumers, retries, dead-letter handling, and manual redrive
- `src/persistence.ts` – D1 idempotent insert plus R2 raw and normalized objects
- `src/fanout.ts` – validation and dispatch for one sink attempt
- `src/registry.ts` – the only place where adapters and sinks are wired in

## License

MIT. See LICENSE.

## Support

Best-effort. Issues and PRs welcome but not promised.
