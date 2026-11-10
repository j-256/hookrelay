CREATE TABLE github_hook_operations (
  id TEXT PRIMARY KEY,
  descriptor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  operation TEXT NOT NULL,
  hook_id INTEGER,
  request_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  auth_fence_json TEXT NOT NULL CHECK(json_valid(auth_fence_json)),
  state TEXT NOT NULL CHECK(state IN ('prepared','submitting','accepted','rejected','indeterminate')),
  provider_status INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX github_hook_operations_pending ON github_hook_operations(descriptor_id,state,updated_at);
CREATE INDEX github_hook_operations_target ON github_hook_operations(descriptor_id,repository_id,target_hash,state);
