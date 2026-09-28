# Scoped management API

Hookrelay owns subscriptions, sinks, delivery state, and the queue engine. Any authorized operator client, including a dashboard backend, CLI tool or MCP service, can inspect selected metadata, review one exhausted delivery for retry, and optionally edit a bounded policy surface through `POST /admin/api/v1`. Policy access can enable or disable an existing subscription, select existing sinks, and change delivery filters. It cannot create, retire, rename, rotate credentials, manage upstream hooks, expose raw events, or confer access to HTML administration. A separate `provision` grant enables [reviewed GitHub hook setup](github-setup.md), which creates a subscription using existing destinations and installs its upstream hook. Hookrelay's local commands own the remaining lifecycle operations. Keep public ingress behind the deployment's admin Access policy; a Worker service binding can call it directly with its own scoped credential.

## Credentials and caller identity

The `MANAGEMENT_CREDENTIALS` Worker secret contains a JSON array of records with `id`, positive integer `revision`, `tokenHash`, `expiresAt`, `workspaceIds`, and `capabilities`. Generate a random 32-byte value, encode it as unpadded base64url, and prefix it with `hkr_`. Store only its lowercase SHA-256 hexadecimal digest in Hookrelay's catalog. Keep the actual token in the calling control plane's secret store and send it as `Authorization: Bearer <token>`. Never put values in URLs, command arguments, logs, or tracked files. Bounds are defined in `src/management/contract.ts` and `src/management/access.ts`.

Every credential requires `read`; add `resolve` only for reviewed operational acknowledgements, add `retry` only when the caller is authorized to review and accept retries, add `configure` only for reviewed subscription policy changes, and add `provision` only for reviewed GitHub hook setup. The caller must authenticate its own users and supply their stable `actorId` and authorized `workspaceId` in each command input. These are assertions by a trusted machine client, not a replacement for the control plane's user authorization. Browser users must not receive the machine credential. Workspace scope is an allowlist for the Hookrelay instance's metadata, not row-level segregation of subscriptions inside that instance. Do not enroll the same instance into unrelated tenants unless they are entitled to see its complete operator metadata.

IDs and token digests must be unique. Removing a catalog entry, advancing its revision, or expiring it invalidates new calls and old unaccepted reviews. Accepted receipts remain bound to the original client revision, workspace, and actor; retain a restricted recovery path before rotating away that identity during an unresolved operation. The HTML test bypass is never honored by the management endpoint. Cloudflare Access context is not inherited by downstream service-binding calls; management authentication is independent of it.

## Contract

Send `{ "command": "snapshot", "input": { "workspaceId": "example", "actorId": "operator" } }`. Inputs are strict and bounded. Successful responses contain `version: 1`, the credential's `read`/`retry`/`resolve` capabilities, and `result`; failures contain a fixed `error.code` and safe `error.message`. Responses are never cached. Request bodies have an explicit byte ceiling and deadline.

| Command | Additional input | Result |
| --- | --- | --- |
| `snapshot` | None | Observed time, bounded delivery totals with sample size and truncation, recent fixed-code signals, last successful retention time |
| `signals` | Optional `resolved` (false, true, or null) and nullable `cursor` | A bounded page of redacted signal identities, occurrence state, and recorded dispositions |
| `resolution_plan` | `planId`, exact `targets`, `reason`, and `note` | Expiring review of operational dispositions; requires `resolve` |
| `resolution_apply` | `planId` | Atomic disposition and durable audit receipt; requires `resolve` |
| `resolution_get` | `planId` | Original review or receipt for the same client revision, workspace, and actor |
| `subscriptions` | Optional nullable `cursor` | Names, source types, enabled state, sink names, continuation, disappeared-record count, observed time |
| `deliveries` | Optional nullable `status`, `subscription`, `cursor` | Selected delivery metadata, scanned candidate count, continuation, observed time |
| `delivery` | `eventId`, `sinkName` | Exact delivery metadata and reviewed state fields |
| `retry_plan` | `planId` UUID, `eventId`, `sinkName`, `generation`, `updatedAt` | Expiring review of the exact exhausted delivery state |
| `retry_apply` | `planId` | Durable acceptance receipt, or a conflict that requires a new review |
| `retry_get` | `planId` | Original review or receipt for reconciliation |
| `configuration` | None | Provider authority identity, mode, revision, and policy availability |
| `configuration_subscriptions` | Authority `revision` and optional nullable `cursor` | Revision-bound page of stable subscription IDs and policy metadata |
| `configuration_subscription` | `resourceId` | One exact subscription's policy and current authority revision |
| `configuration_sinks` | Authority `revision` and optional nullable `cursor` | Revision-bound page of existing sinks and retirement state |
| `configuration_policy_plan` | Authority `revision`, `resourceId`, `planId`, and exact policy | Expiring before/after policy review |
| `configuration_policy_apply` | `planId` | Durable policy acceptance receipt, or a conflict requiring a new review |
| `configuration_policy_get` | `planId` | Original policy review or receipt for reconciliation |
| `github_setup_configuration` | None | Setup availability and missing prerequisite |
| `github_setup_plan` | `planId`, authority ID/revision, nullable `resourceId`, name, repository, events, sinks | Expiring setup or installation review |
| `github_setup_apply` | `planId` | Durable routing and installation progress |
| `github_setup_get` | `planId` | Saved review and read-only reconciliation of uncertain installation |
| `github_setup_status` | `resourceId` | Separate routing, installation and sampled delivery evidence |

Delivery metadata includes the event and sink identity, subscription and source names, generation, status, attempts, fixed filtering reason, received time, update time, and successful delivery time. It excludes provider titles, bodies, URLs, raw storage keys, route hashes, authentication configuration, sink definitions, and exception text. Malformed metadata fails closed with `metadata_invalid`; a failed read is not an empty or healthy instance.

Delivery pagination uses descending `updatedAt`, `eventId`, and `sinkName` keysets. Pass the returned cursor object unchanged. Each read visits a bounded candidate page using the indexed update order, optionally restricted by status. Subscription filtering applies to those candidates, so an empty result can still have `nextCursor`. Continue until the cursor is null, or show that the search is incomplete. This is a live view: updates can move deliveries between pages. Start from the first page to refresh; do not use it as an immutable historical export.

Snapshot totals cover only the most recently updated delivery sample. `truncated: true` means older retained deliveries are omitted, not healthy. Signals are independently capped. A caller must retain this coverage information and observation time when presenting health. Polling performs no durable writes and does not traverse the entire retained history. Subscription pages exclude special provider-configuration entries and expose no storage keys.

## Retry safety and recovery

Review requires an exhausted delivery with the exact generation and update timestamp and an available normalized event. A caller-generated plan identity is stable across a lost review response. Reusing it with different inputs is rejected. Pending reviews are capped per client, workspace, and actor.

Apply checks the client identity, capability, expiry, actor, workspace, retained event, and exact delivery state again. A D1 transaction stores acceptance and advances the delivery to a new pending generation before queue publication. Only the winning transaction can publish that reviewed delivery. The existing outbox reserves its own publication generation; the receipt's `acceptedGeneration` records the durable acceptance boundary, not a promise about the later queue generation. The API uses fixed errors for immediate queue publication failures; existing non-management delivery diagnostics remain unchanged.

An accepted receipt means that retry intent is durable, not that a sink has received it. Queue failures leave pending state for the existing scheduled outbox sweep. Same-plan replay returns the original receipt without republishing, including after the delivery exhausts again or event retention removes it. Inspect `retry_get` after an uncertain response before deciding what happened; do not generate a replacement identity to repeat an unverified action.

Retries use provider-owned sink configuration at execution time, which can change independently of the review. Existing at-least-once delivery guarantees still apply: a sink can receive a duplicate if it accepts a message before success is durably recorded. Raw event retention can expire after a successful availability check. The API does not freeze payload retention or sink configuration and cannot guarantee delivery.

Receipts are retained independently of event foreign keys and pruned in bounded scheduled batches after the configured receipt lifetime. After expiry, use retained operator audit records and delivery state; the provider is not an indefinite audit archive. A fresh review of a later failure is a separate deliberate action.

## Operational dispositions

The separate `resolve` credential grant permits reviewed acknowledgement of retained signals and exhausted deliveries. Neither `retry` nor `configure` implies this grant. Resolution never sends a message, deletes an event, changes retention, or marks a failed delivery successful. An acknowledged delivery remains exhausted in individual and unfiltered history with `resolvedAt` and `resolutionReason`; the exhausted attention filter excludes it. An explicit later reviewed retry starts a new generation and clears that acknowledgement.

Review up to 25 unique targets, bounded to 12 KiB of serialized review input. Signal targets are `{kind: "signal", fingerprint, lastSeenAt, occurrences}`; delivery targets are `{kind: "delivery", eventId, sinkName, generation, updatedAt}`. Copy these values from metadata. Choose `recovered`, `obsolete`, or `accepted-loss` and supply a short printable ASCII note without credentials, payloads, or private URLs. `recovered` records the operator's assessment; it does not reconstruct missing delivery evidence. Resolve related signals explicitly as their own targets.

Reviews expire after five minutes and bind the exact client revision, workspace, actor, inputs, and observed state. Apply is atomic across the selected targets and its receipt. A recurrence, intervening retry, competing resolution, or expired review rejects the whole batch. New occurrences reopen resolved signals. Delivery acknowledgement advances the generation so stale queue messages and earlier retry reviews cannot revive it. Repeating an accepted plan returns its original receipt without resolving a new occurrence.

The provider operator CLI uses the same implementation with its explicit Cloudflare account-operator identity: `pnpm operations signals`, `pnpm operations plan -i <private-input>`, `pnpm operations apply -p <plan-id>`, and `pnpm operations receipt -p <plan-id>`. Use `pnpm operations --help` for input schemas and credential requirements. Inspect each returned review before apply. Lost responses require receipt reconciliation, not a replacement review identity.

Accepted disposition receipts are retained independently of events and signal recurrence. Expired unaccepted reviews use the existing bounded maintenance cleanup. Retained accepted receipts consume D1 storage: the serialized input ceiling alone permits up to approximately 12 MiB per thousand accepted reviews, plus row and index overhead. Operators must account for this audit history in their D1 storage budget and exports. This operation adds no queue, R2, or notification effects.

Apply the additive operational-resolution migration before using the commands. Clients with strict response schemas must accept the optional delivery disposition fields and `resolve` capability before granting resolution access or deploying the provider response changes. Preserve accepted audit receipts across code rollback.

## Deployment and operating limits

Preserve a private D1 export and verify recovery before applying the additive management migration. Apply migrations before deploying code that uses them. Provision the credential through the deployment's secret workflow, preserve existing route and sink state, and leave webhook URL logging disabled where request enrichment would reveal bearer routes. After deployment, verify authenticated metadata and denied anonymous, invalid-credential, and raw requests. Do not resend a real notification as a deployment smoke test. Run the provider's read-only configuration sync check to confirm the API did not change configuration authority.

Code rollback can retain the additive receipt table and indexes. Preserve receipts during rollback so interrupted retries remain investigable; do not restore an entire older D1 export over new delivery history just to roll back code. Remove management credentials and caller bindings if the API is intentionally retired, after unresolved operations have been reconciled.

The API uses bounded requests, indexed candidate reads, capped provider pages, and a bounded maintenance pass. It adds D1 reads, review/receipt writes, R2 metadata reads for retries, and existing queue work after acceptance. These are not a spending ceiling. No measured Free-plan CPU compatibility or free daily capacity is claimed; evaluate real CPU and binding usage against the deployment's workload, record any required Paid-plan allowances, and do not infer safety from access to Workers Paid. Standard-pricing service bindings avoid an additional request fee, but CPU across both Workers and downstream resource usage still matter; review the deployment's [service-binding pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings), including any Workers Cache configuration, before estimating cost.

The snapshot retains bounded recent history and separately returns `signals.unresolved`, an exact summary of every retained unresolved warning, error, or critical signal grouped by the supported code. An index excludes resolved history, but aggregation still reads every matching unresolved record; this is a bounded response, not a bounded database scan. A failed or unsupported summary fails the snapshot instead of implying no failures. `deliveries.acknowledgedExhausted` counts acknowledgements inside the same delivery sample; exhausted totals still preserve failed history. The status-filtered exhausted list contains only unacknowledged failures. Clients should treat ordinary history truncation as informational when both unresolved-summary and exhausted-list reads are complete, while preserving a coverage warning for truncated unresolved failures or older providers without the summary.

The unresolved summary adds an indexed aggregate to the existing snapshot read. For `R` unresolved warning records and `S` snapshot reads, plan for approximately `R * S` additional index entries inspected, plus the sample queries and writes maintaining that index. This is a workload projection, not measured billable-row usage or CPU. Resolved records leave the partial index. Large unresolved histories can exhaust database or invocation limits, making the read unavailable rather than complete. The existing Paid execution profile and [Free fallback](../README.md#cost-guardrails-and-free-compatibility) still apply; this aggregate has not been validated against Free's CPU allowance. Lowering dashboard read frequency reduces this extra work without claiming unobserved history is healthy. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) were verified on 2026-09-28.
