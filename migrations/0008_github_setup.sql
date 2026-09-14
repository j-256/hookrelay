CREATE TABLE github_setup_reviews (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'install')),
  input_hash TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  input_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'configured', 'installing', 'installed', 'rejected', 'indeterminate')),
  webhook_id INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempted_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX github_setup_reviews_owner ON github_setup_reviews(client_id, workspace_id, actor_id, created_at);
CREATE INDEX github_setup_reviews_capacity ON github_setup_reviews(client_id, expires_at);
CREATE INDEX github_setup_reviews_resource ON github_setup_reviews(resource_id, state);
CREATE INDEX github_setup_reviews_retention ON github_setup_reviews(state, expires_at);
