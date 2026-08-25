# Managed subscription fleet integration instructions

## Scope

This directory contains optional operations tooling for managing non-repository Hookrelay subscriptions from an external private manifest. Nothing outside `integrations/subscription-fleet/` may import its modules.

The implementation lives in `src/`, dedicated tests live in `test/`, and the public operator contract lives in `README.md`. The integration may import generic Hookrelay runtime types and operational helpers, but it must not duplicate their implementations.

## Workflow

Run every phase from the Hookrelay repository root with the same private manifest and explicit subscription selections:

```sh
pnpm subscription:fleet plan --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet prepare --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet plan --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet apply --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet verify --manifest <private-manifest> --subscription <name>
pnpm sync
```

`plan` is read-only. `prepare` writes only local recovery-derived configuration. Inspect and checkpoint the private manifest and hash-only route configuration before production mutation. `apply` writes only missing Hookrelay and sender Worker secrets plus selected Hookrelay KV entries. `verify` sends an authenticated CloudEvent whose type must be filtered from every configured sink.

## Secret boundary

The private manifest is the recovery source for raw subscription slugs and HMAC values. It and `.dev.vars` must be regular, non-symlink files with mode `0600`. Raw slugs, full Hookrelay URLs, HMAC values, and secret-bearing request bodies must never reach command arguments, logs, diffs, issues, commits, or chat output.

Sender credentials travel to Wrangler through stdin. Plans and diagnostics may identify secret environment names and sender config paths, but never their values. The ordinary additive workflow does not overwrite existing Worker secrets, rotate credentials, or retire subscriptions.

## Verification

Cover strict manifest parsing, route identity, secret-free plans, unsafe file rejection, selected KV writes, sender secret installation, and authenticated filtered verification in `test/`. Run `pnpm typecheck` and `pnpm test` before considering changes complete. Operational additions also require the documented post-prepare plan, production verification, and final `pnpm sync` comparison.
