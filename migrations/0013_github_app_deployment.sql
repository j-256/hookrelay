CREATE TABLE github_auth_runtime_policy (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('legacy','registry'))
);
INSERT INTO github_auth_runtime_policy(id,revision,mode) VALUES(1,1,'legacy');
ALTER TABLE github_auth_candidates ADD COLUMN prior_policy_revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE github_app_deployments (
  candidate_id TEXT PRIMARY KEY REFERENCES github_auth_candidates(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','stage_intent','stage_indeterminate','staged','deploy_intent','deployment_indeterminate','deployed','verified','conflict')),
  version_id TEXT,
  attestation_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER github_auth_runtime_activation AFTER UPDATE OF state ON github_auth_candidates
WHEN NEW.state='active' AND OLD.state<>'active'
BEGIN
  UPDATE github_auth_runtime_policy SET mode='registry',revision=revision+1 WHERE id=1;
END;
