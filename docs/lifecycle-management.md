# Reviewed destination and hook lifecycle

The version-1 [management API](management.md) supports ordinary destination, subscription, and explicitly owned GitHub hook lifecycle operations through the provider configuration authority. Existing environment-backed destinations and existing clients remain supported. Maintainer HQ supplies browser, CLI, and MCP clients for this contract; deployment, App private keys, and backup restoration remain provider operator responsibilities.

## Authority and grants

Activate the existing D1 configuration authority and apply the management lifecycle migration before deploying dependent code. The `lifecycle_configuration` command returns `authorityId`, `revision`, `mode`, independent `canProvision`, `canConfigure`, `canSupplyPrivate`, and `canManageHooks` flags, a bounded prerequisite `reason`, and `observedAt`. Destination and upstream hook changes require `provision`; subscription retirement and restoration require `configure`. Protected destination input additionally requires `custody` and a valid `HOOK_HANDOFF_KEYS` keyring. Read-only clients retain metadata access and receive no new write authority. Hook availability also reflects the admitted App/token configuration and ingress origin.

Keep `MANAGEMENT_CREDENTIALS` intact for existing clients. Install a distinct additional client in `MANAGEMENT_CREDENTIALS_ADDITIONAL` through protected stdin, with an independent recoverable private source, exact workspace scope, an expiring credential, and only the required grants. The primary catalog remains required and wins ID or token-hash collisions. Invalid additional input does not disable the primary catalog. Retain old client identities while their uncertain receipts need reconciliation.

## Metadata contract

All commands use `POST /admin/api/v1`, the existing bearer credential, version-1 response envelope, and `{workspaceId,actorId}` context. Ordinary inputs and results contain no destination addresses, topics, tokens, signing values, receiver routes, or encrypted documents.

| Command | Additional input | Result |
| --- | --- | --- |
| `lifecycle_configuration` | None | Authority revision and independent operation availability |
| `lifecycle_subscriptions` | Authority `revision` and optional nullable `cursor` | Bounded subscription metadata page with retirement state |
| `lifecycle_subscription` | `resourceId` | Exact subscription policy and retirement state |
| `lifecycle_plan` | `planId`, `authorityId`, `revision`, `change` | Expiring review with safe before/after summaries and private-input requirements |
| `lifecycle_get` | `planId` | Original review and durable outcome, with read-only reconciliation for uncertain hook effects |
| `lifecycle_apply` | `planId` | Configuration receipt or upstream progress for that same review |

`planId` and `resourceId` are UUIDs. Changes are strict tagged variants:

```json
{"kind":"destination-create","name":"notifications","type":"ntfy"}
{"kind":"destination-update","resourceId":"10000000-0000-4000-8000-000000000001","replaceCredentials":true}
{"kind":"destination-retire","resourceId":"10000000-0000-4000-8000-000000000001"}
{"kind":"destination-restore","resourceId":"10000000-0000-4000-8000-000000000001"}
{"kind":"subscription-retire","resourceId":"10000000-0000-4000-8000-000000000001"}
{"kind":"subscription-restore","resourceId":"10000000-0000-4000-8000-000000000001"}
{"kind":"github-hook-adopt","resourceId":"10000000-0000-4000-8000-000000000001","repository":"owner/repository","hookId":42}
{"kind":"github-hook-update","resourceId":"10000000-0000-4000-8000-000000000001","events":["push"],"active":true}
{"kind":"github-hook-delete","resourceId":"10000000-0000-4000-8000-000000000001"}
```

Destination update preserves the destination name and type. `replaceCredentials:false` performs a reviewed metadata reconciliation without replacing its private input. Hook events use the existing supported setup catalog. Upstream ownership is established by an explicit adoption review before update or deletion; local retirement never deletes an upstream hook.

Reviews return `id`, authority identity/revision, public SHA-256 `fingerprint`, `state`, `change`, safe `before`/`after`, bounded `affectedSubscriptions`, `privateInputRequired`, `privateInputReceived`, expiry, `outcome`, and observation time. States are `ready`, `submitting`, `applied`, `failed`, `indeterminate`, and `expired`. Outcomes distinguish provider configuration from the upstream effect. Reusing a plan ID with different inputs fails. Another actor, workspace, or credential revision cannot retrieve the review. Apply rechecks the authority revision, current grant, expiry, and provider authority before effects.

## Protected destination input

After metadata review, send `POST /admin/api/v1/lifecycle-input/<planId>` with the same scoped bearer credential, `Content-Type: application/json`, `X-Workspace-Id`, `X-Actor-Id`, and `If-Match` containing the exact unquoted provider review fingerprint. Identity, grants, review ownership, fingerprint, revision, state, and expiry are checked before reading the body. The request limit is 16384 bytes. Supported private documents are `{type:"discord",url}`, `{type:"ntfy",server?,topic,token?}`, and `{type:"webhook",url,signingSecret}`. Use only the dedicated authenticated input boundary; ordinary metadata commands and hosted MCP inputs cannot carry these values.

Input rejects unsupported protocols, credentialed URLs, fragments, unsafe local destinations, and mismatched types. Responses expose only `{planId,state,privateInputReceived,submitted}`. Repeated consumed input returns metadata without reading or comparing the new body. Competing credential reviews cannot consume each other's staged material. Definite protected-input rejections use `validation` (400), `unauthorized` (401), `forbidden` (403), `not_found` (404), or `conflict`/`expired` (409) before acceptance. Media type, byte-limit, and request-deadline refusals also precede acceptance. Errors after committed custody use `unavailable` (503); retain the same plan ID and reconcile its `privateInputReceived` state before acting again.

Destination custody reuses the existing keyring with the authenticated purpose `hookrelay.destination.v1` and authority/workspace/resource/revision/type binding. It does not rotate, export, or modify the keyring. Configuration stores only a custody reference; encrypted values remain in D1. Delivery resolves the private configuration at execution time, including for retired destinations. Redirects are disabled, response bodies are excluded from destination HTTP errors, and new custody-backed delivery diagnostics expose fixed messages. Preserve both the D1 backup and every key needed to decrypt retained records during recovery; database restoration without those keys cannot restore destination delivery.

## Retirement and upstream recovery

Destination retirement reviews expose the exact enabled subscription references in `affectedSubscriptions`; apply independently refuses those references. Operational-alert references produce an explicit conflict. Unlink through existing routing controls, then prepare a fresh review. Retired destinations cannot be newly selected. The lifecycle subscription metadata aliases include the safe `retired` boolean, so restoration remains discoverable. Existing configuration subscription commands retain their original response shapes for strict older clients. Retirement preserves pending delivery rows, stable names/UUIDs, and custody. Restore clears retirement. Subscription retirement disables the route without removing configuration, history, or accepted delivery decisions; restoration keeps the route disabled until an explicit policy review enables it. Retained events are not replayed.

Adoption reads the authenticated repository's numeric identity and the exact hook. It requires the configured HTTPS ingress origin, correct receiver path and route hash, JSON content, and SSL verification. A matching human name or GitHub's redacted secret proves no ownership or secret equality. `signingVerified` requires a recent successful ping delivery correlated by GUID with the authenticated receiver's retained `ping.event`, after the observed hook configuration generation and with an unchanged exact-hook read. Missing timestamps or ambiguous timestamp precision remain unverified; no real ping or notification is generated by metadata review. Evidence describes the observed hook generation and can become stale after upstream edits.

Updates preserve the receiver URL and recover the existing provider signing value through its original setup, handoff, or environment custody. Updates and deletion persist intent before dispatch in the shared native hook-operation journal, use admitted App/token selection and current fences, bound provider reads, and honor rate limits. Unresolved target operations block another effect. An accepted write with a lost acknowledgement remains recoverable under its original identity. `lifecycle_get` reads exact state and records reconciliation; it never resends an uncertain write. Denied or failed reads do not establish absence. Deletion reconciliation additionally requires a successful complete bounded hook inventory; an exact-hook 404 alone can mask denied access. Historical journal states are preserved when an observation resolves an uncertain effect. Keep unresolved reviews, original credentials, and journal receipts until reconciliation completes.

Settled or expired reviews and unreferenced old custody are pruned in bounded scheduled batches after the provider receipt lifetime. Unresolved reviews and custody referenced by active or retired configuration are retained. This is operational recovery storage, not an indefinite external audit archive.

## Activation and rollback

Before activation, back up provider D1 and the protected keyring, preserve the original management catalog, prepare the additional client catalog privately, and verify the exact existing fixture subscription and destination identities. Deploy only after separate source-integration and deployment approval. Confirm migration presence, active authority identity, scoped client availability, metadata reads, and receipt reconciliation without sending a production notification. Online edits remain authoritative; do not replace them with stale local topology.

Rollback retains D1 custody and lifecycle journals, the previous catalogs, and keyring material. Disabling an additional client stops new requests but can also remove its receipt-reconciliation path, so settle or preserve a restricted recovery identity first. A source rollback must retain runtime support for custody-backed destinations; an older runtime that cannot resolve custody is not a safe delivery rollback after those destinations are created.

## Cloudflare Free and Paid posture

This workflow adds no Cloudflare product or inherent Paid dependency. It shares the deployment's existing [Workers resource-limit requirements](../README.md#cost-guardrails-and-free-compatibility); removing the custom limits is necessary for a Free deployment, and lifecycle cryptography and App authentication have not been CPU-qualified against Free's fixed allowance. Measure representative flows before enabling them on Free. Paid remains justified where the documented production CPU observations exceed Free's allowance.

The official [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), verified 2026-11-13, permit a Free database up to 500 MB, account storage up to 5 GB, five million rows read per day, and 100000 rows written per day. These limits apply across the deployment/account, including event traffic and indexed writes. Exceeding daily query limits causes queries to fail until the daily reset; stored custody is retained. Bounded review/custody pruning limits ordinary settled growth but deliberately preserves unresolved history. A reproducible estimate is `daily accepted credential changes * retained days * encrypted document bytes`, plus the active destinations and SQLite/index overhead. At ten credential changes per day, thirty retained days, and approximately 24 KB per encrypted document, staged history adds approximately 7 MB before overhead. This is a projection, not observed production storage or a guarantee that the complete relay fits Free. Limit review churn, prune settled history, and monitor actual rows/storage; use Paid when the complete workload exceeds these shared limits.
