CREATE TABLE github_hook_operation_reconciliations (
  operation_id TEXT PRIMARY KEY REFERENCES github_hook_operations(id) ON DELETE CASCADE,
  observation TEXT NOT NULL CHECK(observation IN ('present','absent')),
  hook_id INTEGER,
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  auth_fence_json TEXT NOT NULL CHECK(json_valid(auth_fence_json)),
  observed_at INTEGER NOT NULL,
  reconciled_at INTEGER NOT NULL
);
