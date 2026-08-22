# Hookrelay agent instructions

## Project shape

Hookrelay is a provider-agnostic Cloudflare Worker that receives authenticated webhooks, normalizes and persists events, and fans them out to configured sinks. Read the relevant README section and implementation before changing an operational workflow; scripts under `scripts/` are part of the supported operator surface, not disposable development helpers.

The repository has a one-way dependency structure:

- `src/` contains the deployed runtime and must not import `scripts/` or `integrations/`
- `scripts/` contains generic operator commands and provider-specific support under `scripts/providers/`; it must not import optional integrations
- `integrations/` contains optional dogfooding and operations tooling that may depend on the runtime and scripts

GitHub remains a first-class source. Its runtime adapter lives in `src/adapters/github.ts`, while individual-subscription event profiles and repository-hook operations live under `scripts/providers/github/`. Before changing GitHub fleet behavior or files under `integrations/github-fleet/`, read and follow `integrations/github-fleet/AGENTS.md` and its public operational contract in `integrations/github-fleet/README.md`.

`wrangler.jsonc` is committed; its binding ids are opaque, account-scoped resource handles rather than secrets. `routes.jsonc` and `.dev.vars` are ignored, deployment-specific files that carry secrets, and the tracked `routes.example.jsonc` documents the portable shape. Treat all local deployment files as potentially managed through higher-level hardlink or reconciliation instructions, preserve their inode relationships, and edit the authoritative copy when one is specified.

## Secret and recovery boundaries

The general retirement manifest is the recovery source for removed subscription or sink configuration and locally available secret values. It and `.dev.vars` must be regular, non-symlink files with mode `0600`. Manifest paths are operator-owned and must not be embedded in tracked source. If one is stored in another repository, verify that repository's encryption attributes before staging it.

Raw slugs, full Hookrelay URLs, HMAC values, sink credentials, and secret-bearing request bodies must never reach command arguments, logs, diffs, issues, commits, or chat output. `routes.jsonc` may contain subscription names, slug hashes, secret environment names, event profiles, and sink mappings, but never raw values. Inspect private manifests semantically through secret-free names and structure, and inspect encrypted diffs without decrypting their contents into output.

For an individual subscription or sink, use `pnpm sub:retire <name> --manifest <private-manifest>` or `pnpm sink:retire <name> --manifest <private-manifest>`, then rerun with `--finalize` only after reviewing the staged state. These commands use the general retirement manifest, not an integration-specific manifest. A sink remains under `retiredSinks` and in production KV until no subscription or active delivery row references it. Rerun the identical finalization command after interruption; never reconstruct archived values by hand.

## Verification

Generic retirement coverage must exercise strict private manifests, disabled-route ordering, D1 delivery guards, exact provider-resource ownership, shared secret retention, and interrupted finalization. Run `pnpm typecheck` and `pnpm test` before considering code changes complete. Operational changes that affect production workflows additionally require their documented post-prepare plan, production verification, and final `pnpm sync` checks.
