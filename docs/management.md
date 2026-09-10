# Scoped management API

Hookrelay owns subscriptions, sinks, delivery state, and the queue engine. An operator control plane can inspect selected metadata, review one exhausted delivery for retry, and optionally edit a bounded policy surface through `POST /admin/api/v1`. Policy access can enable or disable an existing subscription, select existing sinks, and change delivery filters. It cannot create, retire, rename, rotate credentials, manage upstream hooks, expose raw events, or confer access to HTML administration. Hookrelay's local commands remain the lifecycle management surface. Keep public ingress behind the deployment's admin Access policy; a Worker service binding can call it directly with its own scoped credential.

## Credentials and caller identity

The `MANAGEMENT_CREDENTIALS` Worker secret contains a JSON array of records with `id`, positive integer `revision`, `tokenHash`, `expiresAt`, `workspaceIds`, and `capabilities`. Generate a random 32-byte value, encode it as unpadded base64url, and prefix it with `hkr_`. Store only its lowercase SHA-256 hexadecimal digest in Hookrelay's catalog. Keep the actual token in the calling control plane's secret store and send it as `Authorization: Bearer <token>`. Never put values in URLs, command arguments, logs, or tracked files. Bounds are defined in `src/management/contract.ts` and `src/management/access.ts`.

Every credential requires `read`; add `retry` only when the caller is authorized to review and accept retries, and add `configure` only for reviewed subscription policy changes. The caller must authenticate its own users and supply their stable `actorId` and authorized `workspaceId` in each command input. These are assertions by a trusted machine client, not a replacement for the control plane's user authorization. Browser users must not receive the machine credential. Workspace scope is an allowlist for the Hookrelay instance's metadata, not row-level segregation of subscriptions inside that instance. Do not enroll the same instance into unrelated tenants unless they are entitled to see its complete operator metadata.

IDs and token digests must be unique. Removing a catalog entry, advancing its revision, or expiring it invalidates new calls and old unaccepted reviews. Accepted receipts remain bound to the original client revision, workspace, and actor; retain a restricted recovery path before rotating away that identity during an unresolved operation. The HTML test bypass is never honored by the management endpoint. Cloudflare Access context is not inherited by downstream service-binding calls; management authentication is independent of it.

## Contract

Send `{ "command": "snapshot", "input": { "workspaceId": "example", "actorId": "operator" } }`. Inputs are strict and bounded. Successful responses contain `version: 1`, the credential's `capabilities`, and `result`; failures contain a fixed `error.code` and safe `error.message`. Responses are never cached. Request bodies have an explicit byte ceiling and deadline.

| Command | Additional input | Result |
| --- | --- | --- |
| `snapshot` | None | Observed time, bounded delivery totals with sample size and truncation, recent fixed-code signals, last successful retention time |
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

Delivery metadata includes the event and sink identity, subscription and source names, generation, status, attempts, fixed filtering reason, received time, update time, and successful delivery time. It excludes provider titles, bodies, URLs, raw storage keys, route hashes, authentication configuration, sink definitions, and exception text. Malformed metadata fails closed with `metadata_invalid`; a failed read is not an empty or healthy instance.

Delivery pagination uses descending `updatedAt`, `eventId`, and `sinkName` keysets. Pass the returned cursor object unchanged. Each read visits a bounded candidate page using the indexed update order, optionally restricted by status. Subscription filtering applies to those candidates, so an empty result can still have `nextCursor`. Continue until the cursor is null, or show that the search is incomplete. This is a live view: updates can move deliveries between pages. Start from the first page to refresh; do not use it as an immutable historical export.

Snapshot totals cover only the most recently updated delivery sample. `truncated: true` means older retained deliveries are omitted, not healthy. Signals are independently capped. A caller must retain this coverage information and observation time when presenting health. Polling performs no durable writes and does not traverse the entire retained history. Subscription pages exclude special provider-configuration entries and expose no storage keys.

## Retry safety and recovery

Review requires an exhausted delivery with the exact generation and update timestamp and an available normalized event. A caller-generated plan identity is stable across a lost review response. Reusing it with different inputs is rejected. Pending reviews are capped per client, workspace, and actor.

Apply checks the client identity, capability, expiry, actor, workspace, retained event, and exact delivery state again. A D1 transaction stores acceptance and advances the delivery to a new pending generation before queue publication. Only the winning transaction can publish that reviewed delivery. The existing outbox reserves its own publication generation; the receipt's `acceptedGeneration` records the durable acceptance boundary, not a promise about the later queue generation. The API uses fixed errors for immediate queue publication failures; existing non-management delivery diagnostics remain unchanged.

An accepted receipt means that retry intent is durable, not that a sink has received it. Queue failures leave pending state for the existing scheduled outbox sweep. Same-plan replay returns the original receipt without republishing, including after the delivery exhausts again or event retention removes it. Inspect `retry_get` after an uncertain response before deciding what happened; do not generate a replacement identity to repeat an unverified action.

Retries use provider-owned sink configuration at execution time, which can change independently of the review. Existing at-least-once delivery guarantees still apply: a sink can receive a duplicate if it accepts a message before success is durably recorded. Raw event retention can expire after a successful availability check. The API does not freeze payload retention or sink configuration and cannot guarantee delivery.

Receipts are retained independently of event foreign keys and pruned in bounded scheduled batches after the configured receipt lifetime. After expiry, use retained operator audit records and delivery state; the provider is not an indefinite audit archive. A fresh review of a later failure is a separate deliberate action.

## Deployment and operating limits

Preserve a private D1 export and verify recovery before applying the additive management migration. Apply migrations before deploying code that uses them. Provision the credential through the deployment's secret workflow, preserve existing route and sink state, and leave webhook URL logging disabled where request enrichment would reveal bearer routes. After deployment, verify authenticated metadata and denied anonymous, invalid-credential, and raw requests. Do not resend a real notification as a deployment smoke test. Run the provider's read-only configuration sync check to confirm the API did not change configuration authority.

Code rollback can retain the additive receipt table and indexes. Preserve receipts during rollback so interrupted retries remain investigable; do not restore an entire older D1 export over new delivery history just to roll back code. Remove management credentials and caller bindings if the API is intentionally retired, after unresolved operations have been reconciled.

The API uses bounded requests, indexed candidate reads, capped provider pages, and a bounded maintenance pass. It adds D1 reads, review/receipt writes, R2 metadata reads for retries, and existing queue work after acceptance. These are not a spending ceiling. No measured Free-plan CPU compatibility or free daily capacity is claimed; evaluate real CPU and binding usage against the deployment's workload, record any required Paid-plan allowances, and do not infer safety from access to Workers Paid. Standard-pricing service bindings avoid an additional request fee, but CPU across both Workers and downstream resource usage still matter; review the deployment's [service-binding pricing](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings), including any Workers Cache configuration, before estimating cost.
