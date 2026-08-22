# Optional GitHub fleet integration

This directory contains the repository-fleet operations tooling used to dogfood Hookrelay across many GitHub repositories. It is optional: Hookrelay does not require this integration to receive GitHub webhooks, and ordinary GitHub subscriptions use the core GitHub adapter plus `pnpm sub:add` and `pnpm github:events`.

The integration discovers repositories, maintains a private recovery manifest, prepares one Hookrelay subscription and GitHub repository hook per selected profile, reconciles drift, rotates repository HMACs, retires managed repositories, and verifies end-to-end authentication. It depends on Hookrelay's generic operator helpers and GitHub provider tooling, while nothing in the Worker runtime or ordinary operator scripts depends on the integration.

## Prerequisites

Run every command from the Hookrelay repository root. Before managing a fleet, provide:

- A deployed Hookrelay Worker with its custom domain and Cloudflare resources configured
- `routes.jsonc` and `.dev.vars` for that deployment
- Wrangler access through `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
- An authenticated `gh` CLI identity with repository administration access for every managed repository
- A checkout root whose immediate children are the repositories to discover
- An explicit private manifest path for recoverable repository HMACs and raw subscription slugs
- The sinks required by each selected profile: `discord:repo-activity`, `discord:github-stars`, and `discord:repo-alerts`

The manifest and `.dev.vars` must be regular, non-symlink files with mode `0600`. A manifest stored in another repository must be encrypted before it is staged. Full Hookrelay URLs, raw slugs, HMAC values, and private webhook payloads are secrets.

Review [`src/model.ts`](src/model.ts) before admitting repositories, especially private repositories, because its profile definitions determine which events reach which sinks. The complete profile-to-event table and noise guidance live in [GitHub event profiles](../../docs/providers/github-event-profiles.md).

## Managed topology

Each managed repository has one shared HMAC and one private Hookrelay URL per selected profile:

| Fleet profile | Subscription name | GitHub event profiles | Sink |
| --- | --- | --- | --- |
| `activity` | `github:<owner>/<repo>` | `activity` | `discord:repo-activity` |
| `stars` | `github:<owner>/<repo>:stars` | `stars,watchers` | `discord:github-stars` |
| `alerts` | `github:<owner>/<repo>:alerts` | `alerts` | `discord:repo-alerts` |

The activity profile admits ordinary pushes, workflow runs, and opened or closed pull requests. Force-pushes remain recorded by Hookrelay but are not delivered to sinks. A saved nonempty profile subset is authoritative for that repository; the ordinary additive workflow will not silently change it.

## Recovery manifest

The strict, versioned JSON manifest is the canonical recovery source for each repository's raw slugs and HMAC:

```json
{
  "version": 3,
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
      },
      "profiles": ["alerts"],
      "state": "active"
    }
  },
  "retiredRepositories": {}
}
```

Preparation writes missing entries and refuses unknown fields, malformed values, or conflicts with existing recovery data. Omitted `profiles` selects the complete topology; a present array stores a nonempty subset in canonical `activity`, `stars`, `alerts` order. Active and retiring repositories carry explicit lifecycle state, and a retiring entry also carries resumable hook, route, KV, and secret phase markers. Completed entries move to `retiredRepositories` with their recovery values intact.

`routes.jsonc` contains only slug hashes, subscription names, secret environment names, profile names, and sink mappings. Never reconstruct or manually copy manifest values after an interrupted operation; rerun the identical phase so it reuses the recovery source.

## Enrollment and reconciliation

Use the phases in order with identical root, manifest, repository, visibility, and profile arguments:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet apply --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet verify --root <checkout-root> --manifest <private-manifest> [selection]
pnpm sync
```

`plan` is read-only. It reports discovery, exclusions, drift, exact additions, GitHub administration blockers, remote KV differences, and projected Worker variable and secret capacity. It must complete without blockers before preparation or production mutation.

`prepare` writes only local recovery and desired-state files. Inspect the encrypted-manifest change, hash-only route change, file modes, and any link reconciler state, then rerun the same plan. Checkpoint the recovery manifest and route configuration before applying production changes.

`apply` confirms before writing Worker secrets, selected production KV entries, or GitHub repository hooks. It installs missing HMACs in bulk, waits for authenticated routes to propagate, and creates or repairs only Hookrelay-owned hooks. Use `-y` only after reviewing a plan made with the exact same arguments.

`verify` reports drift without repairing it. For active repositories it sends a fresh GitHub ping through every managed hook in scope, proving that GitHub's unrecoverable copy of the secret agrees with Hookrelay. Ping events are accepted without creating sink deliveries. Finish with `pnpm sync` as an independent desired-state comparison.

The ordinary workflow is additive and resumable. It does not prune stale routes, manifest entries, secrets, or unrelated hooks. A selected canary still audits already-managed public repositories and can therefore report more prepared repositories than the selected addition set. After a partial failure, rerun the same phase with the same selection.

## Repository and profile selection

Repeat `--repo <owner/repo>` to limit new enrollment for a canary. Omit it to select every eligible discovered public repository. Already-managed public repositories remain in the audit scope.

Use `--profiles <comma-separated names>` with explicit repository selectors to enroll a subset:

```sh
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> --repo owner/repo --profiles alerts
```

Repeat the same repository and profile selectors through every phase. Planning and verification require excluded profile routes, Hookrelay-owned hooks, and production KV entries to be absent.

Private admission is explicit. `--include-private` requires at least one `--repo`, admits only the named private repositories, and must be repeated on later audits:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> --repo owner/private-repo --include-private
```

Review the configured sinks before private admission because webhook payloads can contain non-public repository activity and security details.

## HMAC rotation

For an intentional HMAC replacement already recorded in the private manifest, add `--rotate-hmac` to the otherwise identical explicit repository selection in every phase:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> --repo owner/repo --rotate-hmac
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> --repo owner/repo --rotate-hmac
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> --repo owner/repo --rotate-hmac
pnpm github:fleet apply --root <checkout-root> --manifest <private-manifest> --repo owner/repo --rotate-hmac
pnpm github:fleet verify --root <checkout-root> --manifest <private-manifest> --repo owner/repo --rotate-hmac
pnpm sync
```

Preparation replaces private local values only for the selected repositories. Apply rewrites their Worker secrets before repairing hooks through authenticated pings. Never use the flag to work around an unexplained manifest or `.dev.vars` mismatch. Rotation cannot be combined with retirement.

## Repository retirement

Retirement uses the same phase order with an explicit repository selection on every command. Add `--include-private` on every phase for a private repository:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> --repo owner/repo --retire
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> --repo owner/repo --retire
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> --repo owner/repo --retire
pnpm github:fleet apply --root <checkout-root> --manifest <private-manifest> --repo owner/repo --retire
pnpm github:fleet verify --root <checkout-root> --manifest <private-manifest> --repo owner/repo --retire
pnpm sync
```

Prepare writes retirement phase state to the manifest before disabling the selected local routes. Apply syncs the disabled routes, waits for propagation, records exact owned hook IDs before deleting them, removes the routes from local and production KV, deletes only an unshared repository HMAC, and moves completed recovery values to `retiredRepositories`. Each irreversible step has a manifest marker, so rerunning the same command resumes completed work without regenerating values.

Retirement verification checks that selected routes, owned hooks, and safely unshared HMACs are absent. It never sends GitHub pings. Ordinary discovery reports but does not reconcile retiring or retired repositories.

Individual subscription and sink retirement remains part of Hookrelay's generic operator surface. Use `pnpm sub:retire` or `pnpm sink:retire` with their separate retirement manifest rather than the fleet manifest.

## Operational safety

Fleet phases emit secret-free progress while they perform remote reads. Wait for the complete result and check the exit status before drawing conclusions. Remote KV inventories use bulk reads, secret values travel through stdin, and diagnostics must not contain repository names alongside private state, KV values, raw slugs, HMACs, or full Hookrelay URLs.

Route writes account for Workers KV eventual consistency. Apply verifies the central value, probes the public route, and waits through a propagation grace period before creating or updating hooks. Omitted Worker secrets and unrelated repository hooks remain unchanged.
