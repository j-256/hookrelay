# Manual deployment and upgrades

Hookrelay's source verification, public releases, and instance deployments are independent. PRs and pushes to `main` run source checks and generate the project cover. Version tags prepare draft GitHub Releases for human publication. Neither event deploys the Worker.

The optional `deploy production` GitHub Actions workflow deploys a published release or an explicitly selected full commit SHA already on `main`. It runs from `main`, resolves the target once, verifies that exact source, and deploys it using the selected revision's Wrangler configuration. Its orchestration comes from the workflow's pinned `main` commit, so historical release targets do not need to contain the new operator scripts. Release tags must match the selected package version.

## Configure an instance

Review the [sanitized telemetry pipeline](observability.md) before deployment. The source producer selects a dedicated Tail Worker and forbids raw telemetry persistence. Deploy the reviewed sanitizer first, retain separate instance identities, and verify both serving configurations. Existing instances that omit telemetry can retain disabled logging; never enable raw storage to bypass a missing Tail service. The production migration preflight also checks these producer privacy invariants before provider reads.

Create the resources, install runtime secrets, and attach your custom domain using [Deploy your own](../README.md#deploy-your-own). Keep your resource bindings in `wrangler.jsonc` aligned with the instance you intend to deploy. The selected revision supplies those bindings; deploying a historical revision can select historical resource IDs, so review its configuration before choosing it. Ignored `routes.jsonc` and `.dev.vars` files are not uploaded by this workflow. Subscription configuration and runtime secret management remain separate operator workflows.

The queue dispatcher defaults to `hookrelay-delivery` and `hookrelay-delivery-dlq`. Instances using different names must set ordinary Worker variables `DELIVERY_QUEUE_NAME` and `DELIVERY_DLQ_NAME` to their respective consumer queue names, alongside matching producer and dead-letter bindings. Unknown queues are rejected and retried with a delay rather than dispatched as ordinary deliveries. Verify an authenticated fixture event reaches its sink after deploying a new instance.

In your fork's Settings > Secrets and variables > Actions, set `CLOUDFLARE_API_TOKEN` as a repository secret and `CLOUDFLARE_ACCOUNT_ID` as a repository variable. The token needs Workers Scripts Write, Queues Read and Write, and D1 Read access to the target account. Deployment/readback use the existing Wrangler commands. The token is available only to migration preflight, deployment, and provider readback; checkout, dependency installation, and source tests do not receive it. No Cloudflare credentials are needed for ordinary CI or release preparation.

The workflow grants no GitHub Actions cache access through `cache-mode: none`, and dependency setup does not restore or save caches. Cache access is enforced by GitHub's scoped job tokens, independently of whether a cache action runs. See the [dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#controlling-cache-access-with-cache-mode).

Verification and deployment jobs check out the trusted workflow commit, revalidate the selected target's eligibility, and prepare its source in a separate directory before installing or running target code. An expected-SHA mismatch stops the run before that target directory is created. Existing target directories are never overwritten. This keeps target preparation behind validation in the job that will execute it.

Keep Cloudflare Workers Builds disconnected if this manual workflow owns deployment. Otherwise, an independent build connection may still deploy on source pushes.

## Select a deployment

In Actions, choose `deploy production`, select the `main` workflow branch, and choose a mode and revision. The CLI equivalents are:

```sh
# Latest published stable release
gh workflow run deploy.yml --ref main

# An explicit published release, including a published prerelease
gh workflow run deploy.yml --ref main -f mode=release -f revision=vX.Y.Z

# An unreleased commit already reachable from main
gh workflow run deploy.yml --ref main -f mode=main-commit -f revision=FULL_COMMIT_SHA
```

Replace `vX.Y.Z` or `FULL_COMMIT_SHA` with the intended target. Main-commit mode requires the full lowercase commit SHA; branch names, abbreviated SHAs, and commits outside `main` are rejected. Draft releases are rejected. An omitted release revision selects the latest published stable release; if none exists, select an explicit published prerelease or eligible main commit.

GitHub write access is required to dispatch the workflow. A dispatch from another branch is rejected. The resolved source SHA is passed through verification and deployment, so later changes to `main` or a tag cannot change that run's target. Each job rechecks eligibility using its fetched refs and the expected SHA. If those refs identify a different release commit or no longer establish reachability from `main`, preparation stops and requires a new deliberate dispatch. Ref changes after that job's fetch are not observed, and cannot substitute a different commit for the expected SHA. Production runs share a concurrency group that does not cancel an active deployment; inspect Actions for the state of queued requests.

## Apply migrations before deployment

The workflow checks the selected revision's D1 migration files against the production ledger before deploying. It fails closed on missing credentials, unreadable or inconsistent ledgers, pending migrations, or production migrations absent from the selected revision. It never applies migrations automatically.

Review the selected revision's upgrade instructions, preserve any required private backups, and apply its migrations explicitly from a checkout with that revision's instance configuration:

```sh
pnpm exec wrangler d1 migrations apply EVENTS_DB --remote
```

Run the read-only preflight from the deployment tooling checkout, pointing at a separate selected checkout when needed:

```sh
pnpm deploy:check
pnpm deploy:check --config /path/to/selected-checkout/wrangler.jsonc
```

`pnpm release:check` remains a compatibility alias for this preflight. Migration directories are resolved relative to the selected Wrangler file, rather than the tooling checkout. Historical code cannot automatically roll back database state; a differing production ledger blocks its deployment. Do not restore an older database over new delivery history merely to roll back code.

Local deployment remains an explicit operator action: run `pnpm deploy:check` and then `pnpm deploy` from the intended checkout after reviewing its configuration. This local path does not create the manual CI workflow's receipt.

## Verify the result

The workflow reads provider deployment history after Wrangler returns and requires the active deployment to serve the returned Worker version at 100 percent. Missing, unsupported, mismatched, split-traffic, or ambiguous receipts fail verification. The run summary records the selection, package version, resolved source SHA, workflow revision, actor, migration result, command outcomes, and matched provider version/deployment identifiers. It excludes webhook URLs, routing slugs, and credentials.

A successful deploy command alone does not establish provider readback or application health. A failed deploy or readback can leave production changed; inspect the provider's active deployment before retrying, rather than assuming the old version is still active. If the selected historical Wrangler does not emit the supported deploy-v1 structured receipt, verification fails even if the provider accepted its deployment.

Complete the documented authenticated operator checks after provider verification: inspect `/admin/health` and `/admin/events`, verify the affected management operations and access denials, and run the read-only `pnpm sync` from your instance's operator checkout. Do not send a real notification as a deployment probe. The CI summary explicitly leaves runtime health and configuration sync for operator verification; it does not claim those checks passed.
