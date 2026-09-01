# Optional managed subscription fleet integration

This directory contains additive operations tooling for non-repository systems that send signed structured CloudEvents to Hookrelay. It lets an external fleet controller own recoverable subscription credentials while Hookrelay remains responsible for hash-only routes, Worker secrets, production KV, and end-to-end authentication checks.

The integration is optional. Ordinary CloudEvents subscriptions can continue to use `pnpm sub:add` and `pnpm cloudevents:send`.

## Prerequisites

Run every command from the Hookrelay repository root. Before managing a subscription, provide:

- A deployed Hookrelay Worker with `routes.jsonc`, `.dev.vars`, and a public HTTPS `baseUrl`
- Wrangler access through `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
- A strict private manifest containing the selected subscription
- Every referenced sink and its installed Hookrelay Worker secrets
- For automatic sender configuration, an absolute path to that Worker's Wrangler configuration

The manifest, `.dev.vars`, and sender Wrangler configuration must be regular, non-symlink files with mode `0600`. A manifest stored in another repository must be encrypted before it is staged. Full Hookrelay URLs, raw slugs, and HMAC values are secrets.

## Private manifest

Manifest version 1 supports signed structured CloudEvents and an optional Cloudflare Worker sender:

```json
{
  "version": 1,
  "subscriptions": {
    "service-monitor": {
      "source": "cloudevents",
      "sinks": ["discord:service-status"],
      "filter": {
        "eventTypes": {
          "include": [
            "urn:service-monitor:problem:v1",
            "urn:service-monitor:recovered:v1"
          ]
        }
      },
      "sender": {
        "kind": "cloudflare-worker",
        "configPath": "/absolute/path/to/wrangler.jsonc",
        "urlSecretName": "MONITOR_HOOKRELAY_URL",
        "hmacSecretName": "MONITOR_HOOKRELAY_HMAC"
      },
      "recovery": {
        "hmac": {
          "name": "HMAC_SERVICE_MONITOR",
          "value": "<64-lowercase-hex-secret>"
        },
        "slug": "<private-slug>"
      },
      "state": "active"
    }
  }
}
```

The subscription name determines the canonical `HMAC_<NAME>` secret reference. Preparation hashes the raw slug before writing `routes.jsonc`; raw recovery values remain only in the private manifest and `.dev.vars`.

Names, slugs, HMAC names, HMAC values, and sender secret names must not collide within their ownership scopes. Existing route identity is immutable: source, slug hash, authentication scheme, or secret-reference drift is a blocker rather than an update.

## Reconciliation workflow

Use every phase in order with the identical manifest and repeatable subscription selection:

```sh
pnpm subscription:fleet plan --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet prepare --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet plan --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet apply --manifest <private-manifest> --subscription <name>
pnpm subscription:fleet verify --manifest <private-manifest> --subscription <name>
pnpm sync
```

Use `-m, --manifest` and repeatable `-s, --subscription` as equivalent forms. The long names remain canonical in operational runbooks so every phase can be copied with an identical explicit selection.

`plan` is read-only. It validates recovery data, route identity, sink references, private file modes, local and remote secret names, sender secret names, and selected KV differences. Its output contains secret environment names but no raw values or full webhook URLs.

`prepare` writes the selected hash-only routes to `routes.jsonc` and missing matching HMAC values to `.dev.vars`. It refuses a conflicting local HMAC. Inspect and checkpoint those local changes, then rerun the same plan.

`apply` confirms before production mutation unless `-y` is supplied. It installs only missing selected HMACs in the Hookrelay Worker, installs only missing URL and HMAC secrets in configured sender Workers, and writes only selected subscription and sink KV entries. Secret values travel to Wrangler through stdin. Existing secrets are never overwritten.

`verify` first requires the same plan to be converged. It then sends a fresh signed structured CloudEvent through each private route and requires HTTP 200. The stable verification type is `urn:hookrelay:subscription-fleet:verification:v1`; planning refuses a subscription whose filters would deliver that type to any sink. The event is still persisted as a filtered delivery decision, proving authentication and ingress without notifying operators.

Finish with `pnpm sync` as an independent desired-state comparison. Workers KV propagation can be asynchronous, so rerun `verify` if an immediately applied route has not reached the public edge yet.

The workflow is additive and resumable. It does not prune routes, delete or rotate secrets, or retire subscriptions. After interruption, rerun the same phase with the same manifest and selections.
