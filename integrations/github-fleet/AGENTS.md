# GitHub fleet integration agent instructions

## Scope

This directory contains optional dogfooding and operations tooling for managing Hookrelay subscriptions and repository hooks across a GitHub repository fleet. It is not part of the Worker runtime or ordinary GitHub source support. Nothing outside `integrations/github-fleet/` may import its modules.

The implementation lives in `integrations/github-fleet/src/`, its dedicated tests live in `integrations/github-fleet/test/`, and its durable public contract is in `integrations/github-fleet/README.md`. It may import generic Hookrelay types and helpers from `src/`, generic operational helpers from `scripts/`, and GitHub provider helpers from `scripts/providers/github/`. Do not duplicate those implementations inside the integration.

## Fleet workflow

Run every phase from the Hookrelay repository root and pass an operator-supplied checkout root and private manifest path:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet apply --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet verify --root <checkout-root> --manifest <private-manifest> [selection]
pnpm sync
```

Use identical selection arguments for every phase. To add or audit a private repository, replace `[selection]` with `--repo owner/repo --include-private`. Add `--profiles alerts` or another nonempty subset when enrollment should exclude profiles, and repeat it with the other selection arguments. Private admission is explicit: `--include-private` requires at least one `--repo`, admits only the named private repositories, and must be repeated on later audits. Review `GITHUB_FLEET_PROFILES` in `src/model.ts` before private admission because private webhook payloads flow to those configured sinks.

For an intentional HMAC replacement already recorded in the private manifest, add `--rotate-hmac` to the otherwise identical explicit repository selection in every phase. Preparation may replace private local values only for those selected repositories, and apply rewrites their Worker secrets before repairing hooks through authenticated pings. Never use the flag to work around an unexplained manifest or `.dev.vars` mismatch.

`plan` is read-only and must complete without blockers. `prepare` writes only local recovery and desired-state files. Inspect its encrypted-manifest change, hash-only route change, file modes, and any link reconciler state, then rerun the same plan. Checkpoint the recovery manifest and route configuration before production mutation. `apply` writes Worker secrets, production KV, and GitHub repository hooks; use `-y` only after reviewing a plan made with the exact same arguments. `verify` deliberately sends a fresh GitHub ping through every managed hook in scope, but ping events do not create sink deliveries. Finish with `pnpm sync` as an independent desired-state comparison.

A selected canary still audits already-managed public repositories and can report more prepared repositories than the selected addition set. Fleet phases emit secret-free progress while they perform remote reads; wait for the complete result and check the process exit status before drawing conclusions.

The ordinary fleet workflow is additive and resumable. It does not prune stale routes, manifest entries, secrets, or unrelated hooks. After a partial failure, rerun the same phase with the same root, manifest, and selection so it reuses the recovery values and observes completed remote work. Do not regenerate or manually copy values to recover from an interrupted run.

Repository retirement uses the same phase order with an explicit `--repo owner/repo --retire` selection on every command. Add `--include-private` on every phase for a private repository. Prepare writes retirement phase state to the manifest before disabling the selected local routes. Apply syncs the disabled routes, waits for propagation, records exact owned hook IDs before deleting them, removes the routes from local and production KV, deletes only an unshared repository HMAC, and moves completed recovery values to `retiredRepositories`. Verify checks absence without sending a ping. Ordinary discovery reports but does not reconcile retiring or retired repositories.

## Secret and recovery boundaries

The fleet manifest is the canonical recovery source for each repository HMAC and its raw subscription slugs. It and `.dev.vars` must be regular, non-symlink files with mode `0600`. Manifest paths are operator-owned and must not be embedded in tracked source. If a manifest is stored in another repository, verify that repository's encryption attributes before staging it.

Raw slugs, full Hookrelay URLs, HMAC values, sink credentials, and secret-bearing request bodies must never reach command arguments, logs, diffs, issues, commits, or chat output. `routes.jsonc` may contain subscription names, slug hashes, secret environment names, event profiles, and sink mappings, but never raw values. Inspect manifests semantically through secret-free names and structure, and inspect encrypted diffs without decrypting their contents into output.

## Verification

Cover argument parsing, discovery, manifest handling, reconciliation, retirement, partial reruns, shared-state collisions, and secret-free diagnostics in `integrations/github-fleet/test/`. Run `pnpm typecheck` and `pnpm test` before considering fleet code changes complete. Operational additions additionally require the post-prepare plan, production `verify`, and final `pnpm sync` checks documented in the integration README.
