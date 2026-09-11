-- Bookkeeping for every model-derived (and deterministically derived)
-- value: what input produced it, and which recipe. The field values
-- themselves stay on companies/roles/tips; this table is what makes
-- staleness a hash comparison rather than a guess.
--
-- One row per (entity, kind), upserted on every successful compute.
CREATE TABLE derivations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('company', 'role')),
  entity_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  -- The hash of what this value was computed FROM: a snapshot's text_hash
  -- for page-based kinds, or sha256 of the exact context JSON for the
  -- web-research and tips kinds, which read no page.
  source_key TEXT NOT NULL,
  -- sha256 of the .sh file that produced it, so editing a prompt
  -- invalidates its outputs automatically.
  recipe_version TEXT NOT NULL,
  -- 'none' for a deterministic derivation (phrase-list closure,
  -- og:site_name company name), which costs nothing and calls nothing.
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  computed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  job_id INTEGER REFERENCES jobs (id) ON DELETE SET NULL,
  UNIQUE (entity_type, entity_id, kind)
);

CREATE INDEX idx_derivations_entity ON derivations (entity_type, entity_id);
CREATE INDEX idx_derivations_computed_at ON derivations (computed_at DESC, id DESC);
