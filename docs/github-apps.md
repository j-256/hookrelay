# GitHub authentication

Hookrelay can manage repository webhooks using its own GitHub App or an explicitly selected manual token. It works independently of Maintainer HQ. HQ uses a separate App and keeps its own signing key; neither product lends credentials to the other. Both still require the existing Hookrelay management grant, workspace admission and reviewed operation.

One App registration can belong to a trusted deployment operator and serve multiple installations. Each provider descriptor binds one installation, explicit numeric repository identities, admitted management workspaces and hook capabilities. A workspace does not require another App registration. Separate operators can use separate registrations and deployment credentials. An App must be public for other GitHub accounts to install it; this registration setting does not make the Hookrelay or HQ deployment publicly accessible. See [GitHub's visibility rules](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).

## Authentication choices

| Choice | Source of authority | Credential custody | Appropriate use |
| --- | --- | --- | --- |
| App | Live provider descriptor intersected with installation access, repository identity and requested hook capability | Protected local recovery and a named Worker secret | Default for unattended operations |
| Token | Live scoped provider descriptor plus the supplied token's actual provider access | Protected token recovery and a named Worker secret | Advanced option when an App is unsuitable, including deliberate rollback |
| `gh` | Explicitly selected privileged local operator session | Existing GitHub CLI custody | Advanced standalone commands; never an App fallback or workspace management credential |

`--github-auth app|token|gh` is explicit for standalone GitHub operations. App and token modes also require `--github-descriptor <id> --github-workspace <id> --github-credential-file <protected-file>`. The file supplies material, not grants: changing a file cannot add repositories, workspaces or capabilities. Missing keys, unreadable registry state and revoked authority stop the operation. No mode silently substitutes another.

The provider registry lives in `EVENTS_DB` independently of routing's legacy-KV or active-D1 authority. Before registry adoption, the legacy `HOOK_SETUP_GITHUB_TOKEN` configuration remains supported for existing management clients. Activating a reviewed descriptor deliberately changes the runtime authentication policy to registry mode. Disconnecting it does not reactivate that legacy token. Use the deliberate token procedure below instead of changing D1 rows or relying on an environment fallback.

## Register or import

Install locked dependencies and apply the repository's D1 migrations to the selected deployment before using provider lifecycle commands. `pnpm github:app --help` lists the strict grammar, private formats, prerequisites and exit statuses. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through the operator's normal credential custody; lifecycle commands target the account, Worker and `EVENTS_DB` selected by `--config <wrangler-jsonc>`.

For guided registration, choose the owning GitHub account and run:

```sh
pnpm github:app register --account example-owner --account-type Organization --name example-hookrelay --visibility public --homepage https://hooks.example.com --capability repository-hooks-write --output <new-private-recovery> --attempt <new-private-attempt>
```

The command opens a loopback manifest ceremony and asks before opening registration. GitHub supplies the registration confirmation. Hookrelay pins the callback host, path and state, claims the conversion once, and writes protected recovery before reporting success. App-wide webhooks remain inactive, with no event subscriptions or OAuth login flow. See [GitHub's manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

For an existing App or a headless operator, place `{version:1,appId:<numeric-id>,privateKey:<PEM>}` in a protected input file and run `pnpm github:app import -i <private-input> -o <new-private-recovery>`. Input can also come through private piped stdin with `-i -`; never put material in arguments. The command verifies the App identity, normalizes an RSA key to PKCS8, and saves recovery locally. Import does not deploy, activate, change grants or install the App.

Install the App on the intended GitHub account with the intended repository selection. Record its App ID, installation ID, account ID and exact repository numeric IDs, names, owner IDs and visibility for review. Hookrelay only needs repository Webhooks permission: read for inventory, write for create/update/delete/ping. GitHub documents installation-token support for these [repository webhook endpoints](https://docs.github.com/en/rest/repos/webhooks). Requested API tokens contain the exact repository and read/write permission; they expire according to GitHub's [installation-token contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Review, stage, deploy, verify and activate

Create an owner-only metadata input with `{descriptor,expectedRevision,baseVersionId,verificationOrigin}`. For a new descriptor, `expectedRevision` is zero and `revision` and `keyRevision` are one. An App descriptor contains:

```json
{
  "id": "example-provider",
  "revision": 1,
  "keyRevision": 1,
  "mode": "app",
  "appId": 42,
  "installationId": 7,
  "accountId": 50,
  "keySecretName": "GITHUB_APP_EXAMPLE_A",
  "fingerprint": "<public-sha256-fingerprint>",
  "repositories": [{"id":101,"fullName":"example-owner/example-repo","ownerId":50,"private":true}],
  "managementWorkspaces": ["example-workspace"],
  "capabilities": ["repository-hooks-read", "repository-hooks-write"],
  "state": "active"
}
```

Replace illustrative IDs and the fingerprint with reviewed provider observations. Select the exact reviewed, uploaded Worker `baseVersionId`, not a guessed serving version. It must bind the selected `EVENTS_DB`, `CF_VERSION_METADATA`, and every named credential used by active descriptors. `verificationOrigin` is the exact HTTPS origin serving that Worker. Its `/management/github-app-key-verification` endpoint must be reachable for the one-use proof; an edge policy that blocks it must be reviewed separately. The endpoint alone cannot create a challenge or reveal keys.

Run these phases separately and review each concrete result:

```sh
pnpm github:app prepare -i <private-recovery> -p <private-metadata-input>
pnpm github:app stage -i <private-recovery> -d <candidate-id>
pnpm github:app deploy -i <private-recovery> -d <candidate-id>
pnpm github:app verify -i <private-recovery> -d <candidate-id>
pnpm github:app activate -i <private-recovery> -d <candidate-id>
pnpm github:app status -r example-provider
```

`prepare` checks scope, configuration identity, the uploaded version and provider identity, then persists an inactive candidate. `stage` creates an undeployed version with a new named secret and retains prior bindings. `deploy` serves that exact staged code and credential version at 100 percent; it is an explicit production effect. `verify` consumes a short-lived protected challenge and checks the serving runtime's loaded fingerprint against a matching D1 attestation. `activate` rechecks deployment and commits the descriptor and runtime policy through revision CAS. No ordinary management or MCP command can upload keys or activate descriptors. `-y` accepts a reviewed operator lifecycle effect without a prompt; it does not combine the phases.

Preparation and activation are not a claim of end-to-end event delivery. A real repository can still reject a requested event profile or lack the required product settings. The management setup contract retains its existing event allowlist; standalone event profiles retain their separate supported catalog.

## Standalone commands and receiver custody

For a scoped App operation, append the same flags to each root or fleet phase:

```sh
pnpm github:events <subscription> --github-auth app --github-descriptor example-provider --github-workspace example-workspace --github-credential-file <private-recovery>
pnpm github:sync --github-auth app --github-descriptor example-provider --github-workspace example-workspace --github-credential-file <private-recovery>
```

`sub:add`, `sub:retire` and every `github:fleet` phase accept the same choice. Replace `app` with `token` and select its descriptor/recovery for manual tokens. To use existing local GitHub CLI custody deliberately, append `--github-auth gh` without descriptor/file arguments. Fleet checkout-root selection, private-repository admission, profile selection, HMAC/slug rotation and exact owned-hook retirement keep their existing rules.

With no authentication selected, `sub:add` prepares a receiver for manual upstream setup. The `manual` event profile also leaves GitHub's event checkboxes to the administrator. Neither requires an App. `sub:add` and `new-sub` save bearer URLs, email routes and HMAC recovery in a new owner-only file under ignored `.hookrelay-private/`, or at `--private-export <new-private-file>`. Routine output names that file and prints only public setup metadata. Move or back up its contents into appropriate private custody; the slug hash cannot reconstruct the receiver URL. `new-sub` remains a local generator and does not change provider resources.

Signed repository receivers remain the ingress contract. App-key rotation does not rotate a receiver URL, repository HMAC or the manual-handoff custody key. Manual administrator handoff remains separately supported. App-wide event fan-out, hosted signup, GitHub login and GHES are outside this implementation. A successful API-auth check, a signed receiver ping and a sink notification are distinct results: ping ingestion is record-only and does not queue a sink notification.

## Rotation, rollback and uncertain operations

Keep recovery and registration-attempt files owner-only, regular, non-symlink and single-link, with owner-controlled parents. They contain private material. Recovery receipts record metadata about deployment phases; an ambiguous registration conversion is never replayed. Inspect the protected attempt and recovery before continuing, preserving any complete material retained after a failed final write.

For App-key rotation, import the new key, keep the same descriptor ID, increment descriptor and key revisions, choose a new named secret and repeat prepare/stage/deploy/verify/activate. The staged version retains active old credentials. Do not delete old keys as part of adoption; retirement needs a separate review after all consumers switch.

For a deliberate manual-token switch or rollback, place `{version:1,token:<private-value>}` in a protected file and run `pnpm github:app import-token -i <private-input> -o <new-private-recovery>`. This import performs no provider access and claims no permissions. Use the same descriptor ID with incremented revisions, `mode:"token"`, `tokenSecretName:<new-name>` and its public fingerprint; omit App/install/account/key fields and keep repository/workspace/capability grants explicit. Repeat the same staged lifecycle. Preparation checks token repository identity; actual hook endpoints decide write permission. This atomically replaces the selected descriptor without enabling a deployment-wide fallback. Existing receiver custody stays intact.

`disconnect -r <descriptor>` locally disables that descriptor and invalidates its authority. It retains the upstream App, installation, hooks, receiver recovery and keys. Lost staging/deployment responses remain indeterminate until provider readback identifies the exact version; rerunning the same candidate reconciles it without blindly uploading or deploying again. Changed code/configuration, split deployments, mismatched fingerprints and changed revisions stop activation.

Native App/token writes persist intent before dispatch. A network loss after dispatch retains an indeterminate outcome; same-target operations are blocked from automatic redispatch. Inspect bounded metadata with `pnpm github:operations list` plus the same scoped authentication flags. Follow `next` using `--after <id>`; use `--all` for retained historical receipts. Pages are observations of mutable state, so restart a listing after concurrent writes when completeness matters.

For recovery, create a protected review containing `operationId`, `expectedUpdatedAt`, `requestHash`, the exact `originalRequest`, `acknowledgeUncertainOutcome:true`, and `observation:"present"` or `"absent"`. Include private receiver fields only in that file. Ping recovery also needs `expectedWebhookUrl`. Run `pnpm github:operations reconcile -i <private-review>` with the same authentication flags. It previews the exact metadata and asks before any fresh ping. Present recovery requires exact owned-hook/profile/configuration matching and a fresh signed ping. Absence requires the target URL and any known hook ID to be absent. An update to a disabled hook must still obtain a fresh successful signed ping before present recovery can complete.

Recovery appends a later fenced observation and releases the pending-target guard; it never changes the original outcome into success or failure or repeats the original mutation. An absence observation cannot rule out a late provider effect. Reread and review before deliberately starting another operation. If observations, local revisions or provider authority disagree, retain the intent and protected inputs for reconciliation.

## Limits and verification

Authority observations last at most 60 seconds and end sooner with credential expiry. Writes and pings refresh authority immediately before dispatch and check local fences. An explicit App 401 permits one remint for the same serialized request within its deadline; uncertain effects are not retried. Shared installation cooldowns stop other workspaces from bypassing a recorded provider throttle. These checks cannot provide provider CAS or immediate awareness of a missed lifecycle event.

Hook and delivery inventory is bounded and fails closed on truncation. Native responses and request deadlines are bounded, protected files are limited, and pending-operation admission has a fixed ceiling. Request correlation IDs, phase receipts, provider status, current verification and historical outcomes are separate diagnostics. Raw private values are excluded from ordinary responses and journals. See [deployment limits](../README.md#cost-guardrails-and-free-compatibility) for the checked-in Paid execution ceilings and the unverified Free fallback.

Local synthetic coverage exercises App/token/gh hook operations under both routing authorities, old-client setup shapes, private custody, failed provider reads, changed authority, lost acknowledgements, rotation and recovery. It does not establish live GitHub permission parity, deployed cryptographic CPU cost, or notification delivery. Live acceptance needs separately reviewed accounts, Apps, installations, public/private test repositories, an excluded repository, a selected Worker and isolated sinks.
