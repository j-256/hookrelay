CREATE TABLE github_handoff_repositories (
  id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  repository TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  hmac_name TEXT NOT NULL DEFAULT '',
  bundle_revision INTEGER NOT NULL CHECK(bundle_revision > 0),
  encrypted_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(authority_id, repository_key),
  UNIQUE(authority_id, hmac_name)
);
CREATE INDEX github_handoff_repository_workspace ON github_handoff_repositories(workspace_id, id);

CREATE TABLE github_handoff_receivers (
  resource_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES github_handoff_repositories(id),
  profile TEXT NOT NULL CHECK(profile IN ('activity','stars','alerts')),
  auth_mode TEXT NOT NULL CHECK(auth_mode IN ('environment','bundle')),
  created_at TEXT NOT NULL,
  UNIQUE(repository_id, profile)
);

CREATE TABLE github_handoff_reviews (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','adopt')),
  input_hash TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  input_json TEXT NOT NULL,
  encrypted_input TEXT,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','configured')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX github_handoff_review_client ON github_handoff_reviews(client_id, expires_at);
CREATE INDEX github_handoff_review_resource ON github_handoff_reviews(resource_id, created_at);

CREATE TABLE github_handoff_access (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('adopt_plan','reveal','export')),
  created_at TEXT NOT NULL
);
CREATE INDEX github_handoff_access_created ON github_handoff_access(created_at);
