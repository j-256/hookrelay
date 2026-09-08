# Provider-owned configuration

Hookrelay can own runtime configuration in D1 so online policy edits and operator imports use one revisioned authority. Deployment does not import local files, activate this authority or widen management credentials. The initial mode is `legacy`; activation is a separate reviewed provider operation.

## Supported controls

The policy surface controls an existing subscription's enabled state, selection of existing destinations, and subscription-level or per-destination event filters. Creation, retirement, renaming, authentication changes, secret installation and upstream webhook configuration remain unavailable through this surface. Disabling a subscription does not delete its GitHub webhook.

An accepted receipt proves configuration acceptance, not notification delivery. Previously recorded per-sink decisions and queue generations remain unchanged. Signature verification, ingress limits, persistence and retries still apply. Retired destinations remain available for accepted deliveries, but an enabled policy cannot select them.

Resource UUIDs are independent of display names and private route hashes. Duplicate names do not establish identity. Routine metadata excludes private routes, hashes, authentication references, destination credentials, payloads and recovery documents.

## Authority and consistency

`configuration_authority` owns the deployment identity, global revision and mode. Indexed entries hold subscription, destination, operations and retention configuration. Exact runtime reads join the authority to the selected entry. Legacy mode then reads KV; active mode never falls back to KV. Operational `ops-fallback:` records remain in KV because they are runtime state, not configuration.

A parameterized compare-and-swap statement checks identity, revision, mode and expiry. Its trigger applies entries and records a receipt in one transaction, clearing the transient private change payload before completion. Invalid changes roll back the entire statement. Local D1 tests and an isolated remote canary cover competing writers, rollback and lost responses; local query-plan checks verify indexed lookups. These checks do not establish production capacity.

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

Run `pnpm configuration --help` from the deployment checkout. Results and safe policy comparisons go to stdout; diagnostics and confirmations use stderr. The account-level Cloudflare credential authenticates direct D1 access. It is not installed in HQ. Receipts identify this authority as `cloudflare-operator` / `account-operator`, not as a verified individual human.

Private versioned exports and reviews support migration and recovery, not ordinary dashboard editing. Files must be regular non-symlinks with mode `0600`. Output paths must be new files in an owner-controlled directory. Never commit them. Reviews retain the private pre-change configuration; preserve them independently of database receipt retention. Wrangler secrets and retirement manifests keep their separate custody and recovery roles.

```sh
pnpm configuration status
pnpm configuration export --output <new-private-export>
pnpm configuration import-review --input <edited-private-export> --output <new-private-review>
pnpm configuration apply --input <private-review>
pnpm configuration receipt --operation <review-operation-uuid>
```

Keep exported authority identity, revision and resource IDs. Imports support policy changes only, not lifecycle operations, credentials or other settings. Reconcile a stale draft explicitly against a fresh export; never automatically stamp a newer revision onto it. Apply revalidates supported changes against the saved baseline and actual authority. A review fingerprint detects changed content; it is not authorization for arbitrary edits.

## Activation and recovery

Apply repository D1 migrations, including `0006_configuration_authority.sql`, before deploying this runtime or using its operator commands. The migration creates an inactive authority without copying or removing configuration. Legacy command preflights and new reads require D1 Read permission. Apply needs D1 Write, and migration reads also need KV Read.

Before activation, settle or explicitly account for staged retirement, rename, rotation and dependent operator workflows. Preserve private recovery manifests and a provider database backup. Legacy CLI entrypoints refuse an active authority before editing files, installing secrets or changing provider resources. Their active-authority replacements must be supported before relying on those workflows after cutover. Do not activate merely because policy editing is implemented.

Stop legacy writers, including older checkouts and automation, for the migration window. KV cannot participate in the D1 transaction; readback alone cannot exclude an old writer racing activation. Ingress can remain running, but competing configuration writers must not resume. From the deployment checkout:

```sh
pnpm configuration migration-review --routes <private-routes-file> --output <new-private-review>
pnpm configuration apply --input <private-review>
pnpm configuration receipt --operation <review-operation-uuid>
pnpm configuration status
```

Review requires legacy provider configuration to match the private routes file and records stable IDs and retired destination state. Apply rereads KV and refuses observed drift. Activation preserves runtime values; it does not rewrite KV, remove credentials or upstream hooks, or send a canary notification. Verify active configuration and intended ingress/delivery behavior separately after authorized activation.

Never automatically roll an active installation back to KV-only code, toggle its mode to legacy, or restore an old D1 snapshot. That can discard accepted edits or revive old review baselines. Reconcile policy through a fresh review and assess database disaster recovery separately. Missing expired receipts do not prove an operation never occurred.

## Bounds and Free-plan awareness

The authority permits 500 entries and 256 KiB of values in total, with at most 32 KiB per entry. Management pages contain at most 25 records; the existing bounded request body still applies. Policy reviews expire within five minutes, further limited by credential expiry. Each credential can have at most 25 unaccepted, unexpired reviews regardless of claimed actor. Existing scheduled maintenance prunes retained reviews and receipts in bounded batches. No new timer or polling loop is introduced.

Subscription, sink and special-configuration lookups add an indexed D1 read. Legacy mode also reads KV; active mode replaces that KV read. Acceptance writes changed entries, authority, receipt and associated indexes. These bounds are not a spending ceiling; access and abuse protections remain necessary.

D1 is available on Free and Paid. Free includes 5 million rows read and 100,000 written per day; Paid includes 25 billion reads and 50 million writes per month before usage charges. Measure query `rows_read` / `rows_written` and account totals before claiming Free compatibility or increasing capacity. Index writes and retained metadata count toward usage. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [Free daily-limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

This foundation does not relax CPU/subrequest ceilings or enable Workers Logs, whose automatic request metadata can include bearer paths. The existing Paid-only ceilings and Free fallback remain documented in the main README. Activation requires measured CPU, latency and D1 evidence; isolated tests alone establish neither a Free-plan exception nor live health.
