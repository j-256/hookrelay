# GitHub event profiles

`pnpm sub:add` accepts a comma-separated GitHub event selection:

```sh
pnpm sub:add github:example-owner/example-repo github --repo example-owner/example-repo --events activity,alerts
```

Existing subscriptions accept the same selection through `pnpm sub:events <subscription> --events <profiles>`. Omit `--events` to reconcile profile names that were edited directly in `routes.jsonc`.

Composable names expand in the order supplied, and duplicate raw events are removed. Profiles can intentionally overlap, so `activity,workflows` still creates only one `workflow_run` subscription. `push` is the default. `recommended` can be combined with profiles, for example `recommended,stars`. The `all` and `manual` presets are exclusive and cannot be combined with another name.

GitHub recommends subscribing only to events an integration handles. The curated catalog below draws from GitHub's [webhook event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads). Use `all` or `manual` when a repository needs an event outside these profiles.

## Presets

| Name | Expands to | Guidance |
| --- | --- | --- |
| `recommended` | `branch_protection_configuration`, `branch_protection_rule`, `code_scanning_alert`, `dependabot_alert`, `deploy_key`, `issue_comment`, `issues`, `member`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `release`, `repository`, `repository_advisory`, `repository_ruleset`, `secret_scanning_alert`, `security_and_analysis`, `team_add`, `workflow_run` | Best general-purpose set for actionable Discord notifications. It deliberately omits pushes, individual jobs, checks, and commit statuses. |
| `all` | GitHub's `*` wildcard | Full capture at the cost of substantial volume. This preset is exclusive. |
| `manual` | No automatic hook creation | Prepares Hookrelay and leaves GitHub's event checkboxes to you. This preset is exclusive. |

## Composable profiles

| Profile | GitHub events | Use it for |
| --- | --- | --- |
| `access` | `deploy_key`, `member`, `team_add` | Repository access and deploy-key changes. |
| `activity` | `push`, `workflow_run`, `pull_request` | Source changes, completed workflow outcomes, and pull request lifecycle activity. Hookrelay records requested and in-progress workflow runs without delivering them to sinks. |
| `alerts` | `code_scanning_alert`, `dependabot_alert`, `secret_scanning_alert` | Actionable code, dependency, and leaked-secret findings. Resolution events remain visible at informational severity. |
| `branches` | `create`, `delete` | Branch and tag creation or deletion. |
| `checks` | `check_run`, `check_suite`, `status` | Check and commit-status transitions. This can be noisy in active repositories. |
| `commit-comments` | `commit_comment` | Comments attached directly to commits. |
| `deployments` | `deployment`, `deployment_status`, `page_build` | Deployment outcomes and GitHub Pages builds. Hookrelay records creation and transient states but delivers only terminal outcomes. |
| `discussions` | `discussion`, `discussion_comment` | GitHub Discussions activity. |
| `forks` | `fork` | New repository forks. |
| `issues` | `issue_comment`, `issue_dependencies`, `issues`, `label`, `milestone`, `sub_issues` | Issues, their comments and relationships, plus issue metadata administration. |
| `packages` | `package`, `registry_package` | GitHub Packages publication and lifecycle activity. |
| `projects` | `project`, `project_card`, `project_column` | Classic project activity. |
| `pull-requests` | `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` | Pull requests and all review surfaces. Issue-style PR conversation remains in `issues` through `issue_comment`. |
| `push` | `push` | Branch and tag pushes. This is the CLI default. |
| `releases` | `release` | Release publication and lifecycle changes. |
| `repository` | `custom_property_values`, `public`, `repository`, `repository_import` | Repository lifecycle, visibility, imports, and custom properties. |
| `rules` | `branch_protection_configuration`, `branch_protection_rule`, `repository_ruleset` | Branch protection and repository rulesets. |
| `security` | `code_scanning_alert`, `dependabot_alert`, `secret_scanning_alert`, `repository_advisory`, `secret_scanning_alert_location`, `security_and_analysis` | The `alerts` set plus published repository advisories, additional secret locations, and security-feature configuration changes. |
| `stars` | `star` | Stars added or removed. |
| `watchers` | `watch` | A user starting to watch repository notifications. GitHub exposes only the `started` action for this webhook. |
| `webhooks` | `meta`, `ping` | Webhook lifecycle and connectivity diagnostics. Hookrelay records pings without delivering them to sinks. GitHub also sends a ping automatically when a hook is created. |
| `wiki` | `gollum` | Wiki page creation and updates. |
| `workflows` | `workflow_job`, `workflow_run` | GitHub Actions jobs and runs. Hookrelay records non-terminal states but delivers only completed jobs and runs; individual job completions can still be noisy. |

`stars` and `watchers` are intentionally separate. GitHub uses `star` for starring activity and `watch` for repository notification subscriptions.

GitHub repository hooks select `pull_request` as a whole rather than individual actions. The `activity` profile therefore defines one shared normalized event-type rule that every activity subscription inherits: deliver `pull_request.opened` and `pull_request.closed` while retaining other pull request actions as record-only events. Combining `activity` with an unrestricted profile such as `pull-requests` broadens the overlapping event and delivers every pull request action. The standalone `pull-requests` profile remains unfiltered so it can represent every pull request and review surface.

`repository_vulnerability_alert` is omitted because GitHub is closing it down in favor of `dependabot_alert`. `secret_scanning_scan` is also omitted because it reports scan completion rather than a finding. Hooks created with `all` or `manual` can still send either event; Hookrelay records secret-scanning completion without delivering it to sinks.

Security summaries never copy the raw secret value from a `secret_scanning_alert`. The original authenticated payload remains subject to Hookrelay's normal restricted persistence model.

The selected profile names and repository are saved under `subs[].setup.github` in local `routes.jsonc`. They are setup metadata and are not copied into Worker KV. `pnpm sync` compiles shared profile rules, or an explicit subscription override, into runtime filter configuration in Worker KV. The expanded raw events are stored on the GitHub webhook itself. `pnpm sub:events` requires the sender secret mirrored in `.dev.vars` because GitHub's general webhook update clears an omitted secret; it resends that secret and the unchanged hook config through stdin while replacing the event array. Run `pnpm sync` after changing profile metadata so its runtime delivery rule stays aligned. `manual` leaves the remote selection unchanged.
