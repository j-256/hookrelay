# Provider-owned configuration

Hookrelay can own runtime configuration in D1 so online policy edits and provider lifecycle commands use one revisioned authority. Deployment does not import local files, activate this authority or widen management credentials. The initial mode is `legacy`; activation is a separate reviewed provider operation. Activation changes the storage authority, not who is allowed to manage Hookrelay.

## Supported controls

The online policy surface controls an existing subscription's enabled state, selection of existing destinations, and subscription-level or per-destination event filters. Creation, retirement, renaming, authentication changes, secret installation and upstream webhook configuration remain unavailable through that credential-restricted surface. Hookrelay's local lifecycle commands and optional fleet integrations continue to own those operations in both legacy and active modes. Disabling a subscription through policy does not delete its GitHub webhook.

An accepted receipt proves configuration acceptance, not notification delivery. Previously recorded per-sink decisions and queue generations remain unchanged. Signature verification, ingress limits, persistence and retries still apply. Retired destinations remain available for accepted deliveries, but an enabled policy cannot select them.

Resource UUIDs are independent of display names and private route hashes. A slug rotation or finalized sink rename moves the existing UUID to its replacement key rather than creating a new identity. Bounded aliases keep an old runtime key valid across an overlap or historical delivery without duplicating the management resource. Duplicate names do not establish identity. Routine metadata excludes private routes, hashes, authentication references, destination credentials, payloads and recovery documents.

## Authority and consistency

`configuration_authority` owns the deployment identity, global revision and mode. Indexed entries hold subscription, destination, operations and retention configuration; aliases resolve alternate runtime keys to those stable entries. Exact runtime reads join the authority to a canonical entry or alias. Legacy mode then reads KV; active mode never falls back to KV. Operational `ops-fallback:` records remain in KV because they are runtime state, not configuration.

A parameterized compare-and-swap statement checks identity, revision, mode and expiry. Its trigger applies entries, lifecycle moves, aliases and a receipt in one transaction, clearing the transient private change payload before completion. Invalid changes roll back the entire statement. Each command keeps one operation ID through acceptance and checks its receipt if the response is lost. Local D1 tests and an isolated remote canary cover competing writers, rollback and lost responses; local query-plan checks verify indexed lookups. These checks do not establish production capacity.

## Management API

The `/admin/api/v1` envelope remains compatible. Top-level capabilities continue to describe `read` and `retry`; the `configuration` result separately reports `canConfigure`. A credential needs explicit `configure` and `read` authority to review or apply policy changes. Installing code does not change its grants.

| Command | Result or effect |
| --- | --- |
| `configuration` | Authority identity, mode, revision and policy availability |
| `configuration_subscriptions` | Revision-bound page of stable IDs and policy metadata |
| `configuration_subscription` | One exact subscription's policy and revision |
| `configuration_sinks` | Revision-bound page of destinations and retirement state |
| `configuration_policy_plan` | Expiring before/after policy review |
| `configuration_policy_apply` | Accept the saved review once or return its receipt |
| `configuration_policy_get` | Recover its ready, accepted, expired or conflicting outcome |

Reviews bind actor, workspace, credential identity/revision, target, exact policy, authority revision and expiry. Permission removal, changed credentials, stale state or altered input prevent a new apply. After response loss, read the same plan ID instead of creating another operation. Acceptance does not publish a queue message or send a notification.

## Operator workflow

Run `pnpm configuration --help` from the deployment checkout for exports, migration, policy imports, and receipt recovery. Results and safe policy comparisons go to stdout; diagnostics and confirmations use stderr. The account-level Cloudflare credential authenticates direct D1 access. It is not installed in HQ. Receipts identify this authority as `cloudflare-operator` / `account-operator`, not as a verified individual human.

Private versioned exports and reviews support migration and recovery, not ordinary dashboard editing. Files must be regular non-symlinks with mode `0600`. Output paths must be new files in an owner-controlled directory. Never commit them. Reviews retain the private pre-change configuration; preserve them independently of database receipt retention. Wrangler secrets and retirement manifests keep their separate custody and recovery roles.

```sh
pnpm configuration status
pnpm configuration export --output <new-private-export>
pnpm configuration import-review --input <edited-private-export> --output <new-private-review>
pnpm configuration apply --input <private-review>
pnpm configuration receipt --operation <review-operation-uuid>
```

Keep exported authority identity, revision and resource IDs. Imports support policy changes only, not lifecycle operations, credentials or other settings. Reconcile a stale draft explicitly against a fresh export; never automatically stamp a newer revision onto it. Apply revalidates supported changes against the saved baseline and actual authority. A review fingerprint detects changed content; it is not authorization for arbitrary edits.

The ordinary Hookrelay commands remain the lifecycle management surface after activation: `sink:add`, `sub:add`, subscription and sink retirement, sink and secret rename, GitHub event profiles, retention, GitHub Fleet, and managed subscription fleet all read the selected authority. In active mode they submit only their named resources through revision-bound lifecycle changes. Existing online subscription policy is preserved unless the phase explicitly owns the relevant field, so a stale local file cannot overwrite an unrelated HQ edit.

Plain `pnpm sync` is a read-only whole-topology comparison in active mode. It ignores runtime aliases when comparing canonical resources and reports lifecycle-state drift. An unscoped active `pnpm sync -y` is rejected. Use the owning lifecycle command for its narrow policy ownership. An explicit `--put-sub <name>` applies that subscription's complete local configuration, including all policy fields; `--put-sink`, `--put-retention`, and `--put-operations` select their exact resources. Selecting omitted retention or operations configuration explicitly deletes that singleton resource. Legacy mode retains the complete `pnpm sync -y` behavior.

## Activation and recovery

Apply repository D1 migrations through `0007_configuration_lifecycle.sql` before deploying this runtime or using its operator commands. The authority migration creates an inactive authority without copying or removing configuration, while the lifecycle migration adds aliases and lifecycle receipts required by active-capable commands. Provider reads require D1 Read permission. Active apply needs D1 Write, and legacy synchronization or migration reads also need the matching KV permission.

Before activation, settle or explicitly account for staged retirement, rename, rotation and dependent operator workflows. Preserve private recovery manifests and a provider database backup. Deploy this active-capable command implementation before relying on any workflow after cutover, and ensure older checkouts cannot resume configuration writes. Do not activate merely because policy editing is implemented.

Stop legacy writers, including older checkouts and automation, for the migration window. KV cannot participate in the D1 transaction; readback alone cannot exclude an old writer racing activation. Ingress can remain running, but competing configuration writers must not resume. From the deployment checkout:

```sh
pnpm configuration migration-review --routes <private-routes-file> --output <new-private-review>
pnpm configuration apply --input <private-review>
pnpm configuration receipt --operation <review-operation-uuid>
pnpm configuration status
```

Review requires legacy provider configuration to match the private routes file and records stable IDs and retired destination state. Apply rereads KV and refuses observed drift. Activation preserves runtime values; it does not rewrite KV, remove credentials or upstream hooks, or send a canary notification. After authorized activation, verify configuration status, run plain `pnpm sync`, exercise intended ingress and delivery behavior, and run each depended-on fleet's documented verification. Production activation is an operational release step separate from deploying this code.

Never automatically roll an active installation back to KV-only code, toggle its mode to legacy, or restore an old D1 snapshot. That can discard accepted edits or revive old review baselines. Reconcile policy through a fresh review and assess database disaster recovery separately. Missing expired receipts do not prove an operation never occurred.

## Bounds and Free-plan awareness

The authority permits 500 combined canonical entries and aliases, no more than 500 of either kind, and 256 KiB of canonical values in total, with at most 32 KiB per entry. Management pages contain at most 25 records; the existing bounded request body still applies. Policy and lifecycle reviews expire within five minutes. Each management credential can have at most 25 unaccepted, unexpired policy reviews regardless of claimed actor. Existing scheduled maintenance prunes retained reviews and receipts in bounded batches. No new timer or polling loop is introduced.

Subscription, sink and special-configuration lookups add an indexed D1 read. Legacy mode also reads KV; active mode replaces that KV read. Acceptance writes changed entries, authority, receipt and associated indexes. These bounds are not a spending ceiling; access and abuse protections remain necessary.

D1 is available on Free and Paid. Free includes 5 million rows read and 100,000 written per day; Paid includes 25 billion reads and 50 million writes per month before usage charges. Measure query `rows_read` / `rows_written` and account totals before claiming Free compatibility or increasing capacity. Index writes and retained metadata count toward usage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Free daily-limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

This foundation does not relax CPU/subrequest ceilings or enable Workers Logs, whose automatic request metadata can include bearer paths. The existing Paid-only ceilings and Free fallback remain documented in the main README. Activation requires measured CPU, latency and D1 evidence; isolated tests alone establish neither a Free-plan exception nor live health.
