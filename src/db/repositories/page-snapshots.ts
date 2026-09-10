import type Database from 'better-sqlite3';
import { sanitizeOperationalError } from './operational-logs.js';

export interface PageSnapshotRecord {
  id: number;
  url: string;
  url_hash: string;
  fetched_at: string;
  http_status: number | null;
  content_hash: string | null;
  text_hash: string | null;
  bytes: number | null;
  /** 1 when the body hit the fetch size cap. */
  truncated: number;
  /** Relative to the data dir; null when the fetch failed. */
  html_path: string | null;
  /** Relative to the data dir; null when the fetch failed. */
  text_path: string | null;
  error: string | null;
}

export interface InsertPageSnapshotParams {
  url: string;
  urlHash: string;
  fetchedAt: string;
  httpStatus: number | null;
  contentHash: string | null;
  textHash: string | null;
  bytes: number | null;
  truncated?: boolean;
  htmlPath: string | null;
  textPath: string | null;
  /** Sanitized before storage — a fetch failure message can carry the URL's query string. */
  error?: unknown;
}

export function insertPageSnapshot(db: Database.Database, params: InsertPageSnapshotParams): PageSnapshotRecord {
  const result = db
    .prepare(
      `INSERT INTO page_snapshots
       (url, url_hash, fetched_at, http_status, content_hash, text_hash, bytes, truncated, html_path, text_path, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.url,
      params.urlHash,
      params.fetchedAt,
      params.httpStatus,
      params.contentHash,
      params.textHash,
      params.bytes,
      params.truncated ? 1 : 0,
      params.htmlPath,
      params.textPath,
      params.error === undefined ? null : sanitizeOperationalError(params.error),
    );

  const snapshot = getSnapshotById(db, result.lastInsertRowid as number);
  if (!snapshot) throw new Error('Page snapshot vanished immediately after insert');
  return snapshot;
}

export function getSnapshotById(db: Database.Database, id: number): PageSnapshotRecord | undefined {
  return db.prepare('SELECT * FROM page_snapshots WHERE id = ?').get(id) as PageSnapshotRecord | undefined;
}

/** The most recent snapshot of a URL, successful or not — "when did we last try?". */
export function getLatestSnapshot(db: Database.Database, urlHash: string): PageSnapshotRecord | undefined {
  return db
    .prepare('SELECT * FROM page_snapshots WHERE url_hash = ? ORDER BY fetched_at DESC, id DESC LIMIT 1')
    .get(urlHash) as PageSnapshotRecord | undefined;
}

/**
 * The most recent snapshot of a URL that actually captured content — "what
 * do we currently know this page says?". A failed attempt must never count
 * as the current state of a page, or one 503 would suppress the next fetch
 * for the whole refresh window and leave callers with no text to read.
 */
export function getLatestSuccessfulSnapshot(
  db: Database.Database,
  urlHash: string,
): PageSnapshotRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM page_snapshots
       WHERE url_hash = ? AND error IS NULL AND content_hash IS NOT NULL
       ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    )
    .get(urlHash) as PageSnapshotRecord | undefined;
}

export function listSnapshotsForUrl(db: Database.Database, urlHash: string, limit = 50): PageSnapshotRecord[] {
  return db
    .prepare('SELECT * FROM page_snapshots WHERE url_hash = ? ORDER BY fetched_at DESC, id DESC LIMIT ?')
    .all(urlHash, limit) as PageSnapshotRecord[];
}
