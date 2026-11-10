CREATE TABLE github_app_deployment_observations (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES github_auth_candidates(id) ON DELETE CASCADE,
  journal_phase TEXT NOT NULL,
  journal_updated_at INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('historical_staged','historical_deployed','stage_indeterminate','deployment_indeterminate','conflict')),
  version_id TEXT,
  serving_version_id TEXT,
  observed_at INTEGER NOT NULL
);
CREATE INDEX github_app_deployment_observations_candidate ON github_app_deployment_observations(candidate_id,observed_at);
