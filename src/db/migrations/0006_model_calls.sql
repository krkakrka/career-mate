-- An append-only record of every `claude` call: what it cost, which model
-- answered, how many tokens.
--
-- Distinct from `derivations`, which holds one *upserted* row per
-- (entity, kind) — that answers "what did this value last cost", and
-- summing it would count one call per group while a later free
-- deterministic result silently erased the paid call it replaced. Spend is
-- a running total of things that happened, so it needs rows that are never
-- replaced.
CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  entity_type TEXT,
  entity_id INTEGER,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  job_id INTEGER REFERENCES jobs (id) ON DELETE SET NULL
);

CREATE INDEX idx_model_calls_occurred_at ON model_calls (occurred_at DESC, id DESC);
