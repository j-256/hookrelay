CREATE TABLE management_retry_plans (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sink_name TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
  expected_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  write_id TEXT,
  accepted_generation INTEGER
);
CREATE INDEX management_retry_scope_idx
  ON management_retry_plans(client_id, workspace_id, actor_id, expires_at);
CREATE INDEX management_retry_expiry_idx ON management_retry_plans(expires_at);
CREATE INDEX deliveries_management_updated_idx
  ON deliveries(updated_at DESC, event_id DESC, sink_name DESC);
CREATE INDEX deliveries_management_status_idx
  ON deliveries(status, updated_at DESC, event_id DESC, sink_name DESC);
CREATE INDEX operational_signals_management_delivery_idx
  ON operational_signals(event_id, sink_name, code, resolved_at);
