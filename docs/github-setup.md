# Reviewed GitHub hook setup

Hookrelay provides reviewed GitHub subscription creation and repository webhook installation through its [scoped management API](management.md). Any authorized operator client with `read` and `provision` capabilities and the required workspace scope can implement this workflow using existing destinations. Hookrelay owns configuration acceptance, upstream installation and recovery through its active D1 configuration authority. The setup implementation supports GitHub repository webhooks.

A dashboard backend, CLI tool or MCP service can call the same Hookrelay contract with its own scoped credential. Each client authenticates its users, authorizes their workspace access, presents the review for explicit acceptance and retains the plan ID for recovery. Browser interfaces call their trusted backend; browser users never receive the machine credential. Maintainer HQ is one integration, adding repository expectations, project associations and operation history for its browser, CLI and MCP clients. Other clients do not require Maintainer HQ. Deploying Hookrelay or a client does not activate configuration authority, add provider grants or install hooks.

## Provider prerequisites

Apply all provider migrations, including `0008_github_setup.sql`, before deploying this contract. Preserve the normal database backup and active-authority recovery procedures. Activate the [configuration authority](configuration-authority.md) separately if required. At least one active destination must already exist. Keep the existing public ingress and management Access placement.

Provision these values through the provider's privileged secret input workflow. Use interactive secret input or protected file/stdin input; never put secret values in command arguments, logs, routine API responses or tracked files.

| Provider setting | Purpose |
| --- | --- |
| `HOOK_SETUP_KEY` | A securely generated high-entropy root, at least 32 characters, retained in the provider secret store and private recovery custody |
| `HOOK_SETUP_GITHUB_TOKEN` | A dedicated credential with Webhooks read/write permission and access limited to the repositories the setup client may administer |
| `HOOK_SETUP_ORIGIN` | The existing HTTPS ingress origin, without a path, query or fragment |
| `MANAGEMENT_CREDENTIALS` | Add `provision` only to the reviewed client record, retaining `read`, workspace scope, identity, revision and expiry |

The provider creates independent route and signing values from the root and stable resource UUID with domain-separated HMAC derivation. Only the route hash, root environment reference and non-secret setup metadata enter configuration storage. The derived route and signing value are sent directly to GitHub over HTTPS. The same provider runtime derives the signing value when validating ingress. These values never pass through management clients.

Preserve the root for the lifetime of its subscriptions. Replacing or deleting it changes derived signing values and prevents fresh setup verification; it is not a supported rotation procedure. A credential or ingress-origin change invalidates unaccepted reviews. Review provider-owned rotation, retirement and recovery separately, preserving stable resource identity and the original setup metadata. Do not use an older configuration writer that drops `auth.derivationId` or `githubSetup` metadata. An explicit local `--put-sub` replacement still owns the full subscription, so inspect its private configuration before applying it.

GitHub's repository webhook API documents the Webhooks permissions and create response; request signatures use the webhook secret. Setup uses the versioned API and rejects redirects. These prerequisites describe the credential to provision, not permissions observed for a particular account. References verified 2026-09-14: [repository webhook API](https://docs.github.com/en/rest/repos/webhooks) and [validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

## Review and recovery

`github_setup_configuration` returns an explicit unavailable reason until the authority, grant and provider prerequisites are ready. `github_setup_plan` binds the original machine credential/revision, workspace, actor, provider authority/revision, repository, subscription name, destinations, event selection and expiry. It creates no routing or upstream webhook. Reuse the same plan ID after a lost review response; changed inputs require a different review.

`github_setup_apply` first accepts the named subscription in the provider authority. It then reads bounded GitHub webhook inventory. A matching installed hook can resolve the operation. Before any GitHub POST, a conditional D1 write durably claims installation. Only that claim may send the request; replay returns the recorded progress. A definitive GitHub rejection leaves the configured subscription available for another explicit installation review. A failed preflight leaves routing configured and permits a fresh installation review for that resource UUID.

An interrupted POST remains indeterminate. `github_setup_get` reconciles through bounded GitHub reads and never sends another POST. A later empty inventory cannot prove that the original request will not finish. An unresolved claim prevents a replacement installation review. Preserve it for provider investigation when reads cannot establish the outcome; do not clear the record or invent another subscription to bypass it. There is no automatic rollback of routing, upstream deletion or notification retry.

`github_setup_status` reports enabled routing with destinations, observed upstream installation and the last successful delivery in a bounded recent event sample separately. Installation checks compare the exact route, active state, JSON content type, TLS verification setting and event selection. GitHub does not return the configured signing secret, so a configuration match cannot prove that a later secret edit still matches Hookrelay; authenticated ingress and delivery remain separate evidence. Legacy subscriptions without setup metadata report installation as unverified. GitHub's setup ping does not establish notification delivery.

Successful routing acceptance is retained independently of installation failure. Reviews and completed receipts are pruned in bounded maintenance batches after their retention lifetime; configured, installing and indeterminate progress is preserved for recovery. Fixed-code `github.setup.incomplete` diagnostics include the operation UUID, resource UUID, whether POST was attempted and elapsed milliseconds. Raw provider exceptions, response bodies, routes and credentials are excluded.

## Bounds and deployment verification

`GITHUB_SETUP_LIMITS` caps a verification at three GitHub pages of 100 hooks, 256 KiB per response and an eight-second network deadline. A complete preflight can issue at most one additional POST. An inventory beyond the bound reports incomplete verification and prevents installation. Delivery evidence inspects only the newest 25 events for that subscription; no successful delivery in that sample is not a claim about older retained history. Review inputs select at most 25 existing destinations. The authority's entry, byte, review and receipt-retention limits also apply.

For one reviewed setup with a complete preflight, the reproducible external-request estimate is at most four GitHub requests; each later verification or reconciliation adds at most three. D1 review, configuration, intent and receipt writes, indexes, existing fan-out, HMAC work and response parsing add independent cost. This flow adds no scheduled GitHub polling. Bounded synthetic tests do not measure hosted CPU, billable rows or Free compatibility. The existing [Paid execution ceilings and Free fallback](../README.md#cost-guardrails-and-free-compatibility) still govern the deployment; leave `provision` ungranted to omit online installation while retaining ordinary configuration and administration. Paid headroom supports durable per-effect recording and recovery without weakening those checks.

After an authorized deployment, verify migrations, authenticated availability and metadata, denied invalid credentials, and the provider's read-only configuration comparison. Availability may correctly report missing setup settings. Installing a real repository webhook, changing grants and provisioning secrets are separate deliberate rollout actions. Exercise creation, signing, failures and recovery against isolated synthetic repositories before authorizing production effects.
