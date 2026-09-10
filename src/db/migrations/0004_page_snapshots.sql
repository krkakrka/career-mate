-- Raw fetched pages become immutable, append-only sources (Phase 2): every
-- fetch of a URL adds a row here plus files on disk under
-- .data/pages/<url_hash>/. Nothing is ever overwritten — a re-fetch whose
-- body is byte-identical still records a row (so "we checked, unchanged" is
-- visible) while reusing the previous snapshot's files.
CREATE TABLE page_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  -- sha256 of the URL exactly as given (not normalized): this is the
  -- directory name on disk, so it has to round-trip a specific string.
  url_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  -- Null on a network-level failure (nothing to report a status for).
  http_status INTEGER,
  -- content_hash/text_hash/bytes/html_path/text_path are all null together
  -- on a failed fetch: the row records the attempt, but there is no content.
  content_hash TEXT,
  text_hash TEXT,
  bytes INTEGER,
  -- 1 when the body hit the fetch size cap, so a snapshot that is merely
  -- cut off is distinguishable from one that is genuinely short.
  truncated INTEGER NOT NULL DEFAULT 0,
  -- Paths relative to the data dir, so .data stays movable and CM_DATA_DIR-overridable.
  html_path TEXT,
  text_path TEXT,
  error TEXT
);

-- "Latest snapshot for this URL" = the first row of this index. id DESC is
-- the tiebreaker for two snapshots taken within the same millisecond.
CREATE INDEX idx_page_snapshots_url_hash ON page_snapshots (url_hash, fetched_at DESC, id DESC);
