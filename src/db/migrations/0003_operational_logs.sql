CREATE TABLE operational_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'retried', 'skipped')),
  component TEXT NOT NULL,
  action TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  entity_type TEXT,
  entity_id INTEGER,
  context TEXT,
  error TEXT
);

CREATE INDEX idx_operational_logs_occurred_at ON operational_logs (occurred_at DESC, id DESC);
CREATE INDEX idx_operational_logs_job ON operational_logs (job_id, occurred_at DESC, id DESC);
CREATE INDEX idx_operational_logs_entity ON operational_logs (entity_type, entity_id, occurred_at DESC, id DESC);
CREATE INDEX idx_operational_logs_severity ON operational_logs (severity, occurred_at DESC, id DESC);
