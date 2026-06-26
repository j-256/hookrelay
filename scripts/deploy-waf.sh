#!/bin/bash
# Deploy hookrelay WAF rules to a Cloudflare zone.
# Usage: ./scripts/deploy-waf.sh <zone-name> [--apply]
# Defaults to dry-run; pass --apply to actually deploy.
#
# Rules are read from scripts/waf-rules.example.jsonc (or $RULES_FILE). Each rule
# is matched in the zone's http_request_firewall_custom entrypoint ruleset by its
# description: an existing rule with the same description is PATCHed in place, a new
# one is POST-appended. Other rules in the ruleset (e.g. fleet-wide rules deployed by
# a separate tool) are never touched -- this script does NOT replace the ruleset.
#
# Environment:
#   CLOUDFLARE_API_TOKEN   Required. Needs Zone:Read + Zone WAF:Edit.

set -eu

SCRIPT_NAME="deploy-waf.sh"
RULES_JSON="$(mktemp -t hookrelay-rules.XXXXXX)"

__unset() {
  rm -f "$RULES_JSON"
  unset SCRIPT_NAME ZONE_NAME APPLY RULES_FILE ZONE_ID ENTRYPOINT RULESET_ID RULES_JSON CREATE_PAYLOAD RULE_COUNT
  unset -f __unset _api _deploy_rule
}
trap __unset EXIT

ZONE_NAME="${1:-}"
APPLY="${2:-}"
RULES_FILE="${RULES_FILE:-$(dirname "$0")/waf-rules.example.jsonc}"

if [ -z "$ZONE_NAME" ]; then
  echo "usage: $SCRIPT_NAME <zone-name> [--apply]" >&2
  exit 2
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN not set" >&2
  exit 2
fi

# Thin curl wrapper for the Cloudflare API. Args: METHOD PATH [JSON_BODY]
_api() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      --data "$data" \
      "https://api.cloudflare.com/client/v4${path}"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4${path}"
  fi
}

# Strip // line comments so the JSONC rules file parses as JSON, then validate.
sed 's://.*$::' "$RULES_FILE" > "$RULES_JSON"
if ! jq empty "$RULES_JSON" 2>/dev/null; then
  echo "error: $RULES_FILE did not parse as JSON after comment strip" >&2
  exit 1
fi

ZONE_ID="$(_api GET "/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')"
if [ -z "$ZONE_ID" ]; then
  echo "error: zone not found (or token lacks Zone:Read): $ZONE_NAME" >&2
  exit 1
fi

# Fetch the http_request_firewall_custom phase entrypoint ruleset. A 404 here means
# no custom ruleset exists yet on the zone -- we create it lazily on first apply.
ENTRYPOINT="$(_api GET "/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint")"
RULESET_ID="$(printf '%s' "$ENTRYPOINT" | jq -r '.result.id // empty')"

echo "Zone:       $ZONE_NAME ($ZONE_ID)"
echo "Ruleset:    ${RULESET_ID:-<none yet>}"
echo "Rules file: $RULES_FILE"
echo

# Deploy one rule by description: PATCH if a same-description rule exists, else POST-append.
# Reads from the already-fetched $ENTRYPOINT so we don't refetch per rule.
_deploy_rule() {
  local desc="$1"
  local expr="$2"
  local action="$3"
  local existing_id
  existing_id="$(printf '%s' "$ENTRYPOINT" | jq -r --arg d "$desc" \
    '.result.rules[]? | select(.description == $d) | .id' | head -n1)"

  local payload
  payload="$(jq -n --arg d "$desc" --arg e "$expr" --arg a "$action" \
    '{description: $d, expression: $e, action: $a, enabled: true}')"

  if [ -n "$existing_id" ]; then
    echo "  PATCH  rule '$desc' (id $existing_id)"
    if [ "$APPLY" = "--apply" ]; then
      _api PATCH "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules/${existing_id}" "$payload" \
        | jq -r 'if .success then "         -> ok" else "         -> ERROR: \(.errors)" end'
    fi
  else
    echo "  APPEND rule '$desc'"
    if [ "$APPLY" = "--apply" ]; then
      _api POST "/zones/${ZONE_ID}/rulesets/${RULESET_ID}/rules" "$payload" \
        | jq -r 'if .success then "         -> ok" else "         -> ERROR: \(.errors)" end'
    fi
  fi
}

# If no entrypoint ruleset exists, the first apply must CREATE it (POST to /rulesets)
# carrying all our rules. Subsequent runs take the PATCH/append path above.
if [ -z "$RULESET_ID" ]; then
  CREATE_PAYLOAD="$(jq '{
    name: "default",
    kind: "zone",
    phase: "http_request_firewall_custom",
    rules: [.rules[] | {description, expression, action, enabled: true}]
  }' "$RULES_JSON")"
  echo "  No custom ruleset on this zone yet -- would CREATE one with $(jq '.rules | length' "$RULES_JSON") rule(s)."
  if [ "$APPLY" != "--apply" ]; then
    echo
    echo "Dry run -- not modifying. Re-run with --apply to deploy."
    printf '%s\n' "$CREATE_PAYLOAD"
    exit 0
  fi
  _api POST "/zones/${ZONE_ID}/rulesets" "$CREATE_PAYLOAD" \
    | jq -r 'if .success then "  -> created ruleset with \(.result.rules | length) rule(s)" else "  -> ERROR: \(.errors)" end'
  exit 0
fi

# Ruleset exists: deploy each rule from the file by description (coexists with other rules).
if [ "$APPLY" != "--apply" ]; then
  echo "Dry run -- not modifying. Re-run with --apply to deploy."
  echo
fi

RULE_COUNT="$(jq '.rules | length' "$RULES_JSON")"
i=0
while [ "$i" -lt "$RULE_COUNT" ]; do
  desc="$(jq -r --argjson i "$i" '.rules[$i].description' "$RULES_JSON")"
  expr="$(jq -r --argjson i "$i" '.rules[$i].expression' "$RULES_JSON")"
  action="$(jq -r --argjson i "$i" '.rules[$i].action' "$RULES_JSON")"
  _deploy_rule "$desc" "$expr" "$action"
  i=$((i + 1))
done
