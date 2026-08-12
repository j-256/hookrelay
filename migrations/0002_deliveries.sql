CREATE TABLE deliveries (
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sink_name      TEXT NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'processing', 'retrying', 'delivered', 'exhausted')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  delivered_at   TEXT,
  lease_until    TEXT,
  PRIMARY KEY (event_id, sink_name)
);

INSERT INTO deliveries (
  event_id,
  sink_name,
  generation,
  status,
  attempts,
  last_error,
  created_at,
  updated_at,
  delivered_at
)
SELECT
  events.id,
  result.key,
  0,
  CASE WHEN json_extract(result.value, '$.ok') = 1 THEN 'delivered' ELSE 'exhausted' END,
  CASE
    WHEN json_type(result.value, '$.attempts') = 'integer'
      AND json_extract(result.value, '$.attempts') >= 0
    THEN json_extract(result.value, '$.attempts')
    ELSE 0
  END,
  json_extract(result.value, '$.errMsg'),
  events.received_at,
  COALESCE(json_extract(result.value, '$.updatedAt'), events.received_at),
  CASE
    WHEN json_extract(result.value, '$.ok') = 1
    THEN COALESCE(json_extract(result.value, '$.updatedAt'), events.received_at)
    ELSE NULL
  END
FROM events, json_each(
  CASE WHEN json_valid(events.fanout_results) THEN events.fanout_results ELSE '{}' END
) AS result
WHERE json_type(result.value) = 'object';

CREATE INDEX deliveries_status_updated_idx ON deliveries(status, updated_at);
