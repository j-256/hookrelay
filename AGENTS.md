# Hookrelay agent instructions

## Project shape

Hookrelay is a Cloudflare Worker that receives authenticated webhooks, normalizes and persists events, and fans them out to configured sinks. Read the relevant README section and the implementation before changing an operational workflow; scripts under `scripts/` are part of the supported operator surface, not disposable development helpers.

`wrangler.jsonc` is committed; its binding ids are opaque, account-scoped resource handles rather than secrets. `routes.jsonc` and `.dev.vars` are ignored, deployment-specific files that carry secrets, and the tracked `routes.example.jsonc` documents the portable shape. Treat all local deployment files as potentially managed through higher-level hardlink or reconciliation instructions, preserve their inode relationships, and edit the authoritative copy when one is specified.

## GitHub fleet workflow

The GitHub fleet implementation lives in `scripts/github-fleet*.ts`. Its durable public contract is in the README section "Managing a GitHub repository fleet". Run every phase from the Hookrelay repository root and pass an operator-supplied checkout root and private manifest path:

```sh
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet prepare --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet plan --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet apply --root <checkout-root> --manifest <private-manifest> [selection]
pnpm github:fleet verify --root <checkout-root> --manifest <private-manifest> [selection]
pnpm sync
```

Use the identical selection arguments for every phase. To add or audit a private repository, replace `[selection]` with `--repo owner/repo --include-private`. Private admission is explicit: `--include-private` requires at least one `--repo`, admits only the named private repositories, and must be repeated on later audits. Review `GITHUB_FLEET_PROFILES` in `scripts/github-fleet-model.ts` before private admission because private webhook payloads flow to those configured sinks.

`plan` is read-only and must complete without blockers. `prepare` writes only local recovery and desired-state files. Inspect its encrypted-manifest change, hash-only route change, file modes, and any link reconciler state, then rerun the same plan. Checkpoint the recovery manifest and route configuration before production mutation. `apply` writes Worker secrets, production KV, and GitHub repository hooks; use `-y` only after reviewing a plan made with the exact same arguments. `verify` deliberately sends a fresh GitHub ping through every managed hook in scope, but ping events do not create sink deliveries. Finish with `pnpm sync` as an independent desired-state comparison.

A selected canary still audits already-managed public repositories, so fleet phases can stay quiet while they perform remote reads and can report more prepared repositories than the selected addition count. Wait for the complete plan or phase result and check the process exit status before drawing conclusions.

The ordinary fleet workflow is additive and resumable. It does not prune stale routes, manifest entries, secrets, or unrelated hooks. After a partial failure, rerun the same phase with the same root, manifest, and selection so it reuses the recovery values and observes completed remote work. Do not regenerate or manually copy values to recover from an interrupted run.

Repository retirement uses the same phase order with an explicit `--repo owner/repo --retire` selection on every command. Add `--include-private` on every phase for a private repository. Prepare writes retirement phase state to the manifest before disabling the three local routes. Apply syncs the disabled routes, waits for propagation, records exact owned hook IDs before deleting them, removes the routes from local and production KV, deletes only an unshared repository HMAC, and moves completed recovery values to `retiredRepositories`. Verify checks absence without sending a ping. Ordinary discovery reports but does not reconcile retiring or retired repositories.

For an individual subscription or sink, use `pnpm sub:retire <name> --manifest <private-manifest>` or `pnpm sink:retire <name> --manifest <private-manifest>`, then rerun with `--finalize` only after reviewing the staged state. These commands use their own retirement manifest schema, not the fleet manifest. A sink remains under `retiredSinks` and in production KV until no subscription or active delivery row references it. Rerun the identical finalization command after interruption; never reconstruct archived values by hand.

## Secret and recovery boundaries

The fleet manifest is the canonical recovery source for each repository HMAC and its three raw subscription slugs. The general retirement manifest is the recovery source for removed subscription or sink configuration and locally available secret values. Both manifests and `.dev.vars` must be regular, non-symlink files with mode `0600`. Manifest paths are operator-owned and must not be embedded in tracked source. If one is stored in another repository, verify that repository's encryption attributes before staging it.

Raw slugs, full Hookrelay URLs, HMAC values, sink credentials, and secret-bearing request bodies must never reach command arguments, logs, diffs, issues, commits, or chat output. `routes.jsonc` may contain subscription names, slug hashes, secret environment names, event profiles, and sink mappings, but never the raw values. Inspect manifests semantically through secret-free names and structure, and inspect encrypted diffs without decrypting their contents into output.

## Verification

For fleet changes, cover argument parsing, discovery, manifest handling, reconciliation, retirement, partial reruns, shared-state collisions, and secret-free diagnostics in the corresponding `test/unit/github-fleet*.test.ts` files. General retirement coverage must exercise strict private manifests, disabled-route ordering, D1 delivery guards, exact hook ownership, shared secret retention, and interrupted finalization. Run `pnpm typecheck` and `pnpm test` before considering code changes complete. Operational additions additionally require the post-prepare plan, production `verify`, and final `pnpm sync` checks described above.
