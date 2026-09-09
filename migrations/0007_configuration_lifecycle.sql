CREATE TABLE configuration_aliases (
  namespace TEXT NOT NULL CHECK (namespace IN ('SUBS', 'SINKS')),
  alias_key TEXT NOT NULL CHECK (length(alias_key) BETWEEN 1 AND 240),
  resource_id TEXT NOT NULL REFERENCES configuration_entries(resource_id) ON DELETE CASCADE,
  PRIMARY KEY (namespace, alias_key)
);

CREATE INDEX configuration_aliases_resource ON configuration_aliases (resource_id);

ALTER TABLE configuration_receipts RENAME TO configuration_receipts_before_lifecycle;

CREATE TABLE configuration_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  authority_id TEXT NOT NULL,
  revision INTEGER NOT NULL UNIQUE,
  before_revision INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('migration', 'import', 'policy', 'lifecycle')),
  resource_id TEXT,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  accepted_at TEXT NOT NULL
);

INSERT INTO configuration_receipts (
  id, authority_id, revision, before_revision, client_id, client_revision,
  workspace_id, actor_id, kind, resource_id, input_hash, accepted_at
)
SELECT id, authority_id, revision, before_revision, client_id, client_revision,
  workspace_id, actor_id, kind, resource_id, input_hash, accepted_at
FROM configuration_receipts_before_lifecycle;

DROP TABLE configuration_receipts_before_lifecycle;

CREATE INDEX configuration_receipts_owner
ON configuration_receipts (client_id, workspace_id, actor_id, accepted_at);

CREATE INDEX configuration_receipts_retention ON configuration_receipts (accepted_at);

DROP TRIGGER configuration_accept;

CREATE TRIGGER configuration_accept
AFTER UPDATE OF pending_change ON configuration_authority
WHEN NEW.pending_change IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid configuration transition')
  WHERE NEW.revision != OLD.revision + 1
    OR NEW.authority_id != OLD.authority_id
    OR NEW.mode != 'active';

  DELETE FROM configuration_aliases
  WHERE (namespace, alias_key) IN (
    SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key')
    FROM json_each(NEW.pending_change, '$.aliasDeletes')
  );

  DELETE FROM configuration_entries
  WHERE (namespace, entry_key) IN (
    SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key')
    FROM json_each(NEW.pending_change, '$.deletes')
  );

  UPDATE configuration_entries
  SET entry_key = (
    SELECT json_extract(move.value, '$.toKey')
    FROM json_each(NEW.pending_change, '$.moves') AS move
    WHERE json_extract(move.value, '$.namespace') = configuration_entries.namespace
      AND json_extract(move.value, '$.fromKey') = configuration_entries.entry_key
  )
  WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.pending_change, '$.moves') AS move
    WHERE json_extract(move.value, '$.namespace') = configuration_entries.namespace
      AND json_extract(move.value, '$.fromKey') = configuration_entries.entry_key
  );

  INSERT INTO configuration_entries (namespace, entry_key, resource_id, retired, value)
  SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key'),
    json_extract(value, '$.resourceId'), coalesce(json_extract(value, '$.retired'), 0), json_extract(value, '$.value')
  FROM json_each(NEW.pending_change, '$.puts') WHERE true
  ON CONFLICT (namespace, entry_key) DO UPDATE SET
    resource_id = excluded.resource_id, retired = excluded.retired, value = excluded.value;

  INSERT INTO configuration_aliases (namespace, alias_key, resource_id)
  SELECT json_extract(value, '$.namespace'), json_extract(value, '$.key'), json_extract(value, '$.resourceId')
  FROM json_each(NEW.pending_change, '$.aliasPuts') WHERE true
  ON CONFLICT (namespace, alias_key) DO UPDATE SET resource_id = excluded.resource_id;

  SELECT RAISE(ABORT, 'configuration inventory exceeds supported bounds')
  FROM (
    SELECT
      (SELECT count(*) FROM configuration_entries) AS entry_count,
      (SELECT count(*) FROM configuration_aliases) AS alias_count,
      (SELECT sum(length(CAST(value AS BLOB))) FROM configuration_entries) AS value_bytes
  )
  WHERE entry_count > 500 OR alias_count > 500 OR entry_count + alias_count > 500 OR value_bytes > 262144;

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
