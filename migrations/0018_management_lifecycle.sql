CREATE TABLE lifecycle_reviews (
  id TEXT PRIMARY KEY CHECK(length(id)=36),
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  affected_json TEXT NOT NULL CHECK(json_valid(affected_json)),
  auth_identity TEXT,
  auth_fence_json TEXT,
  hook_before_hash TEXT,
  private_required INTEGER NOT NULL DEFAULT 0,
  private_received INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','submitting','applied','failed','indeterminate','expired')),
  outcome_json TEXT,
  error_code TEXT,
  hook_operation_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX lifecycle_reviews_owner ON lifecycle_reviews(client_id,workspace_id,actor_id,state,expires_at);
CREATE INDEX lifecycle_reviews_resource ON lifecycle_reviews(resource_id,state);

CREATE TABLE destination_custody (
  plan_id TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('discord','ntfy','webhook')),
  encrypted_json TEXT NOT NULL CHECK(json_valid(encrypted_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(resource_id,revision)
);
CREATE TABLE lifecycle_owned_hooks (
  resource_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  hook_id INTEGER NOT NULL,
  target_hash TEXT NOT NULL,
  events_json TEXT NOT NULL CHECK(json_valid(events_json)),
  active INTEGER NOT NULL,
  signing_verified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
