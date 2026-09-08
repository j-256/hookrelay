CREATE TABLE configuration_authority (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE CHECK (length(authority_id) = 32),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  mode TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'active')),
  operation_id TEXT,
  pending_change TEXT CHECK (pending_change IS NULL OR json_valid(pending_change))
);

INSERT INTO configuration_authority (singleton, authority_id)
VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE configuration_entries (
  namespace TEXT NOT NULL CHECK (namespace IN ('SUBS', 'SINKS')),
  entry_key TEXT NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 240),
  resource_id TEXT NOT NULL UNIQUE CHECK (length(resource_id) = 36),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  value TEXT NOT NULL CHECK (json_valid(value) AND length(CAST(value AS BLOB)) <= 32768),
  PRIMARY KEY (namespace, entry_key)
);

CREATE INDEX configuration_entries_page ON configuration_entries (namespace, resource_id);

CREATE TABLE configuration_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL UNIQUE,
  before_revision INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('migration', 'import', 'policy')),
  resource_id TEXT,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  accepted_at TEXT NOT NULL
);

CREATE INDEX configuration_receipts_owner
ON configuration_receipts (client_id, workspace_id, actor_id, accepted_at);

CREATE INDEX configuration_receipts_retention ON configuration_receipts (accepted_at);

CREATE TABLE configuration_policy_reviews (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX configuration_policy_reviews_owner
ON configuration_policy_reviews (client_id, workspace_id, actor_id, expires_at);
CREATE INDEX configuration_policy_reviews_retention ON configuration_policy_reviews (expires_at);
CREATE INDEX configuration_policy_reviews_capacity ON configuration_policy_reviews (client_id, expires_at);

CREATE TRIGGER configuration_accept
AFTER UPDATE OF pending_change ON configuration_authority
WHEN NEW.pending_change IS NOT NULL
BEGIN
  -- Keep guards free of CASE expressions, which fail remote D1 migration parsing
  SELECT RAISE(ABORT, 'invalid configuration transition')
  WHERE NEW.revision != OLD.revision + 1
    OR NEW.authority_id != OLD.authority_id
    OR NEW.mode != 'active';

  DELETE FROM configuration_entries
  WHERE (namespace, entry_key) IN (
    SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key')
    FROM json_each(NEW.pending_change, '$.deletes')
  );

  INSERT INTO configuration_entries (namespace, entry_key, resource_id, retired, value)
  SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key'),
    json_extract(value, '$.resourceId'), coalesce(json_extract(value, '$.retired'), 0), json_extract(value, '$.value')
  FROM json_each(NEW.pending_change, '$.puts') WHERE true
  ON CONFLICT (namespace, entry_key) DO UPDATE SET
    resource_id = excluded.resource_id, retired = excluded.retired, value = excluded.value;

  SELECT RAISE(ABORT, 'configuration inventory exceeds supported bounds')
  FROM (
    SELECT count(*) AS entry_count, sum(length(CAST(value AS BLOB))) AS value_bytes
    FROM configuration_entries
  )
  WHERE entry_count > 500 OR value_bytes > 262144;

  INSERT INTO configuration_receipts (
    id, authority_id, revision, before_revision, client_id, client_revision,
    workspace_id, actor_id, kind, resource_id, input_hash, accepted_at
  ) VALUES (
    NEW.operation_id, NEW.authority_id, NEW.revision, OLD.revision,
    json_extract(NEW.pending_change, '$.clientId'),
    json_extract(NEW.pending_change, '$.clientRevision'),
    json_extract(NEW.pending_change, '$.workspaceId'),
    json_extract(NEW.pending_change, '$.actorId'),
    json_extract(NEW.pending_change, '$.kind'),
    json_extract(NEW.pending_change, '$.resourceId'),
    json_extract(NEW.pending_change, '$.inputHash'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  UPDATE configuration_authority SET pending_change = NULL WHERE singleton = 1;
END;
