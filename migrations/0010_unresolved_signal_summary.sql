CREATE INDEX operational_signals_open_summary
ON operational_signals(code, severity, last_seen_at, occurrences)
WHERE resolved_at IS NULL;
