CREATE TABLE deliveries_vnext (
  event_id         TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sink_name        TEXT NOT NULL,
  generation       INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'processing', 'retrying', 'delivered', 'filtered', 'exhausted')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       TEXT,
  decision_reason  TEXT CHECK (decision_reason IS NULL OR decision_reason IN ('source-record-only', 'subscription-filter', 'sink-filter')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  delivered_at     TEXT,
  lease_until      TEXT,
  PRIMARY KEY (event_id, sink_name)
);

INSERT INTO deliveries_vnext (
  event_id,
  sink_name,
  generation,
  status,
  attempts,
  last_error,
  created_at,
  updated_at,
  delivered_at,
  lease_until
)
SELECT
  event_id,
  sink_name,
  generation,
  status,
  attempts,
  last_error,
  created_at,
  updated_at,
  delivered_at,
  lease_until
FROM deliveries;

DROP TABLE deliveries;
ALTER TABLE deliveries_vnext RENAME TO deliveries;
CREATE INDEX deliveries_status_updated_idx ON deliveries(status, updated_at);

CREATE TABLE operational_signals (
  fingerprint      TEXT PRIMARY KEY,
  code             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
  source           TEXT,
  sub_name         TEXT,
  event_id         TEXT,
  sink_name        TEXT,
  summary          TEXT NOT NULL,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  occurrences      INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  resolved_at      TEXT
);

CREATE INDEX operational_signals_last_seen_idx ON operational_signals(last_seen_at DESC);
CREATE INDEX operational_signals_code_last_seen_idx ON operational_signals(code, last_seen_at DESC);

CREATE TABLE operational_alert_deliveries (
  fingerprint         TEXT NOT NULL REFERENCES operational_signals(fingerprint) ON DELETE CASCADE,
  sink_name           TEXT NOT NULL,
  alerted_occurrences INTEGER NOT NULL DEFAULT 0 CHECK (alerted_occurrences >= 0),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at     TEXT,
  next_attempt_at     TEXT,
  last_error          TEXT,
  delivered_at       TEXT,
  PRIMARY KEY (fingerprint, sink_name)
);

CREATE INDEX operational_alerts_due_idx ON operational_alert_deliveries(next_attempt_at);

CREATE TABLE maintenance_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
