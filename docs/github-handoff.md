# Manual GitHub webhook handoff

Use manual handoff when a trusted third-party repository administrator will install the GitHub webhook. Hookrelay creates the authenticated receiver and retains recoverable credentials; the operator privately hands the URL, signing secret and event selection to that administrator. This workflow requires no local repository checkout or GitHub administrator token. [Automatic setup](github-setup.md) remains available when Hookrelay itself should install the upstream hook.

## Provider custody and grants

Apply migrations including `0011_github_handoffs.sql` and activate the [D1 configuration authority](configuration-authority.md) before enabling creation. Existing destinations must already be configured. Provision the existing HTTPS `HOOK_SETUP_ORIGIN` and the `HOOK_HANDOFF_KEYS` wrapping keyring through protected secret input. Manual readiness does not require `HOOK_SETUP_KEY` or `HOOK_SETUP_GITHUB_TOKEN`.

The keyring is a strict JSON object with `version: 1`, `activeKeyId`, and `keys: [{ id, key }]`. Each `key` is the canonical padded base64 encoding of a securely generated 32-byte AES key. Keep IDs unique and retain every key needed by stored bundles. Generate and transfer the document through a protected file or stdin; never pass values as arguments. Preserve a protected recovery copy independently of the Worker. Changing the active key affects new bundles; it does not rewrap accepted bundles. Removing an old key makes its bundles unavailable. Key rotation, rewrapping and hook retirement require a separate migration workflow.

Grant `read` and `handoff` to the selected management client with explicit workspace scope, identity, revision and expiry. Add `custody` only when that client is authorized for private adoption, retrieval and export. These are separate from the automatic installer's `provision` grant. Deploying a compatible client never adds grants or provisions keys automatically.

Each case-insensitive GitHub repository identity owns one immutable encrypted bundle containing a shared HMAC and distinct reserved activity, stars and alerts slugs. Only accepted profiles become live. AES-GCM binds the ciphertext to its authority, workspace, repository UUID, repository name, bundle revision and key ID. Configuration contains hashes, keyring references and safe ownership metadata; it does not contain the raw bundle. Database backups without the required wrapping keys cannot restore private retrieval or bundle-authenticated ingress.

## Reviewed management protocol

Use the existing `POST /admin/api/v1` metadata contract for `github_handoff_configuration`, `github_handoff_repository`, `github_handoff_plan`, `github_handoff_apply`, `github_handoff_get` and `github_handoff_status`. All requests carry workspace and actor context. Creation binds the original management credential/revision, authority/revision, repository, profile, destinations, resource identity and expiry. Reuse the same review ID after interruption. Apply accepts the exact reviewed receiver and credentials through the configuration authority; it never calls GitHub or sends a Discord notification. Concurrent first creation or case aliases cannot establish different bundles for the same repository.

Profiles use canonical fleet names: `github:owner/repository`, `github:owner/repository:stars` and `github:owner/repository:alerts`. Activity requests GitHub `push`, `workflow_run` and `pull_request` events, with delivery filters for push changes, workflow activity, and opened or closed pull requests. Stars requests `star`; alerts requests `code_scanning_alert`, `dependabot_alert` and `secret_scanning_alert`. Choose destinations appropriate to the trust and sensitivity of each profile. Adding a profile reuses the established signing secret and its reserved slug.

Credential transport is a separate `POST /admin/api/v1/private/github-handoff` contract with actions `adopt_plan`, `reveal` and `export`. It requires both handoff and custody authority. Requests and responses are bounded; responses are `no-store`, private lookups check stored workspace ownership, and raw errors are discarded. Generic command results, reviews and receipts contain safe metadata only. Private access emits a correlation ID, action, outcome and timing without values. Review and access history use bounded retention; accepted bundles remain available independently of that history.

Reveal returns one receiver URL, the shared signing secret, event names, `application/json`, SSL verification, and the repository's GitHub settings URL. The administrator chooses individual events, keeps the webhook active and SSL verification enabled, then sends GitHub's ping. Status reports routing, authenticated ping and successful notification delivery separately over a bounded retained-event sample. An absent observation is not proof of upstream absence. A ping is not a notification delivery or an exhaustive inspection of GitHub settings.

Missing or corrupt custody material causes a typed ingress credential-store failure and HTTP 503. Invalid signatures return HTTP 401. Inspect the `ingress-credentials-unavailable` signal and correlated private-access diagnostics before retrying; never regenerate credentials to clear an unexplained failure.

## Adopting an existing receiver

An existing ordinary environment-HMAC fleet receiver must be adopted before adding profiles. Supply only its selected active unbound recovery record through the private `adopt_plan` boundary, then review and apply its safe receipt. Adoption verifies the HMAC against the runtime secret and each raw slug against the accepted hash. It preserves resource UUIDs, environment authentication, enabled state, sink policy, filters, and the administrator's existing upstream hook. Pending rotations, retirement, alternate keys, automatic-derived authentication and already-bound records are rejected.

Adoption must include every canonical legacy profile for the repository. If configuration acceptance loses a revision race after private custody was reserved, prepare a fresh adoption review at the new revision using the identical recovery values. Hookrelay reuses that immutable reservation only while all receivers remain ordinary legacy records with exact identities. Once adoption is accepted, reconcile its original receipt instead of adopting again.

Maintainer HQ supplies trusted local CLI/MCP file adapters for this private selection. Its browser does not accept a whole recovery manifest. Preserve the original export and review ID after a partial result. Adding stars or alerts after adoption uses bundle authentication for those new receivers while the adopted receiver retains its established environment secret.

## Local recovery mirror

Private export returns a version-one envelope containing one repository recovery record, non-secret provider binding and accepted route snapshots. The optional [GitHub fleet integration](../integrations/github-fleet/README.md) imports it into the operator's encrypted recovery manifest and optional explicitly selected authoritative route file:

```sh
pnpm github:handoff:recovery inspect -i <private-export> -m <private-manifest> [-r <golden-routes>] [-d <private-dev-vars>]
pnpm github:handoff:recovery import -i <private-export> -m <private-manifest> [-r <golden-routes>] [-d <private-dev-vars>] -y
```

Private files must be existing regular non-symlink mode-0600 files. Initialize a new empty manifest with `{"version":4,"repositories":{},"retiredRepositories":{}}` using protected file creation if needed. When the manifest is inside Git, import requires `filter=git-crypt` and `diff=unset`; verify encryption before separately staging it. Route files must be the operator-selected authoritative source, not a linked runtime target. The importer never discovers private stores or stages/commits files.

Import validates every route hash, provider UUID, scope, profile and authentication reference. It upgrades to manifest v5, preserves unrelated records, refuses replaced HMACs/slugs/bindings, and permits additional profile bindings only while existing identities remain unchanged. The manifest is written and read back first, route snapshots second, optional development HMAC mirroring last. Bundle profiles do not need a per-repository Worker secret; adopted environment profiles still do. Wrapping-key restoration is separate from the HMAC mirror. Keep the export on failure and repeat the identical selection; diagnostics identify the failed stage and whether the manifest write completed.

Legacy fleet preparation, rotation, retirement and individual GitHub event writers reject or skip provider-managed records before mutation. Read-only fleet planning labels this excluded lifecycle coverage. Unrelated legacy records remain supported. Ordinary `pnpm sync` preserves bundle authentication and ownership metadata and can compare the exported route snapshots. Full explicit subscription replacement still owns its selected record; inspect it before any provider write.

## Cloudflare Free-plan considerations

Limits verified against [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) on 2026-11-05: Free includes 5 million rows read/day, 100,000 rows written/day, 5 GB total D1 storage, 100,000 Worker requests/day and 10 ms CPU per invocation. These account-level and invocation-level limits are independent. Indexes add write/storage cost, and a query's billable rows are not its returned row count.

Each bundle-authenticated ingress adds one indexed D1 join over the repository, receiver, configuration entry and active authority, plus AES-GCM decryption. For a projected 10,000 such events/day, budget 10,000 additional queries/day. A planning allowance of eight billable rows per lookup would consume 80,000 additional row reads/day; this is an estimate, not a measured query plan or a guarantee. Measure `meta.rows_read` and invocation CPU for representative signed payloads before enabling production traffic on Free. Custody adds no per-event write; existing event and delivery persistence still consumes the underlying relay's allowances.

For a reproducible storage projection, allow 32 KiB per repository including bounded ciphertext and metadata, then add receiver indexes and retained reviews/access audits separately. At the provider's configured repository cap, that allowance is approximately 16 MiB before those additional tables. Immutable bundles are not pruned with review history. The feature introduces no inherent Paid-only service, but combined relay CPU, D1 usage, logging and request quotas remain unverified on Free. Exceeding daily D1 quotas makes queries fail until reset; custody failures remain HTTP 503. Keep new receivers disabled until a measured Free workload fits, or use Paid when the existing relay workload or measured overhead requires it. The README records the deployed relay's separate Paid ceilings and observed Free CPU exceedance.
