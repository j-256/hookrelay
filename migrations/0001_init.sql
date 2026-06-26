CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  received_at     TEXT NOT NULL,
  sender_at       TEXT,
  sub_slug        TEXT NOT NULL,
  sub_name        TEXT NOT NULL,
  source          TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT,
  severity        TEXT,
  r2_key          TEXT NOT NULL,
  fanout_results  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_received_at_idx ON events(received_at DESC);
CREATE INDEX events_sub_received_idx ON events(sub_slug, received_at DESC);
