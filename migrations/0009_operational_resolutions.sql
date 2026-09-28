ALTER TABLE operational_signals ADD COLUMN resolution_reason TEXT;
ALTER TABLE deliveries ADD COLUMN resolved_at TEXT;
ALTER TABLE deliveries ADD COLUMN resolution_reason TEXT;

CREATE INDEX operational_signals_open_page
ON operational_signals(last_seen_at DESC, fingerprint DESC) WHERE resolved_at IS NULL;

CREATE TABLE operational_resolution_reviews (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  targets_json TEXT NOT NULL CHECK (json_valid(targets_json) AND json_array_length(targets_json) BETWEEN 1 AND 25),
  reason TEXT NOT NULL CHECK (reason IN ('recovered', 'obsolete', 'accepted-loss')),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX operational_resolution_reviews_owner
ON operational_resolution_reviews(client_id, client_revision, workspace_id, actor_id, expires_at);

CREATE TRIGGER operational_resolution_accept
AFTER UPDATE OF applied_at ON operational_resolution_reviews
WHEN OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'operational review expired')
  WHERE julianday(NEW.expires_at) <= julianday('now');

  SELECT RAISE(ABORT, 'operational state changed')
  WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.targets_json) t WHERE NOT (
      (json_extract(t.value, '$.kind') = 'signal' AND EXISTS (
        SELECT 1 FROM operational_signals s
        WHERE s.fingerprint = json_extract(t.value, '$.fingerprint')
          AND s.last_seen_at = json_extract(t.value, '$.lastSeenAt')
          AND s.occurrences = json_extract(t.value, '$.occurrences')
          AND s.resolved_at IS NULL
      )) OR
      (json_extract(t.value, '$.kind') = 'delivery' AND EXISTS (
        SELECT 1 FROM deliveries d
        WHERE d.event_id = json_extract(t.value, '$.eventId')
          AND d.sink_name = json_extract(t.value, '$.sinkName')
          AND d.generation = json_extract(t.value, '$.generation')
          AND d.updated_at = json_extract(t.value, '$.updatedAt')
          AND d.status = 'exhausted' AND d.resolved_at IS NULL
      ))
    )
  );

  UPDATE operational_signals SET resolved_at = NEW.applied_at, resolution_reason = NEW.reason
  WHERE fingerprint IN (
    SELECT json_extract(value, '$.fingerprint') FROM json_each(NEW.targets_json)
    WHERE json_extract(value, '$.kind') = 'signal'
  );

  UPDATE deliveries SET resolved_at = NEW.applied_at, resolution_reason = NEW.reason,
    updated_at = NEW.applied_at, generation = generation + 1
  WHERE (event_id, sink_name) IN (
    SELECT json_extract(value, '$.eventId'), json_extract(value, '$.sinkName')
    FROM json_each(NEW.targets_json) WHERE json_extract(value, '$.kind') = 'delivery'
  );

END;
