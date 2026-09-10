import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadSettings } from '../config/settings.js';
import {
  getLatestSuccessfulSnapshot,
  insertPageSnapshot,
  type PageSnapshotRecord,
} from '../db/repositories/page-snapshots.js';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { getDataDir } from '../lib/paths.js';
import { truncateAtCodePoint } from '../lib/truncate.js';
import { fetchRawPage, FetchError, type RawPage } from './fetch.js';
import { deriveText } from './text.js';

/** Which refresh policy (`settings.page_refresh_days`) applies to a URL. */
export type PageKind = 'role' | 'company';

export interface SnapshotPageOptions {
  kind: PageKind;
  /**
   * Take a new snapshot now, ignoring `page_refresh_days`. That is *all*
   * force means — it never overwrites or invalidates derived data. A new
   * snapshot with a different hash is what makes derivations stale.
   */
  force?: boolean;
}

interface SnapshotFilePaths {
  htmlPath: string;
  textPath: string;
}

/**
 * The bound on model input, now that the raw fetch cap only guards memory.
 * Derived text of even a very large page is normally well under this; a
 * page that exceeds it is a listing wall or a data dump, and the first
 * chunk is the part that describes the posting.
 */
const MAX_TEXT_LENGTH = 250_000;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The identity of a URL in the page store: sha256 of the URL exactly as given. */
export function hashUrl(url: string): string {
  return sha256(url);
}

/** Snapshot paths are stored relative to the data dir so .data stays movable (and CM_DATA_DIR-overridable). */
export function resolvePagePath(relativePath: string): string {
  return path.join(getDataDir(), relativePath);
}

/**
 * Reads the derived text of a snapshot — what gets piped to an extraction
 * script. Never the HTML: the whole point of the derivation is that the
 * model sees the small, clean form.
 */
export function readSnapshotText(snapshot: PageSnapshotRecord): string {
  if (!snapshot.text_path) {
    throw new Error(
      `Page snapshot #${snapshot.id} of ${snapshot.url} has no derived text (${snapshot.error ?? 'fetch captured no content'})`,
    );
  }
  return fs.readFileSync(resolvePagePath(snapshot.text_path), 'utf-8');
}

/**
 * Reads a snapshot's raw HTML. Used by the deterministic derivations,
 * which read structured metadata (`<title>`, `og:*`, `<link rel=canonical>`)
 * out of the markup that states it, rather than out of the flattened text —
 * body text shaped like `key: value` is indistinguishable from a header
 * line once the page has been flattened.
 */
export function readSnapshotHtml(snapshot: PageSnapshotRecord): string {
  if (!snapshot.html_path) {
    throw new Error(
      `Page snapshot #${snapshot.id} of ${snapshot.url} has no stored HTML (${snapshot.error ?? 'fetch captured no content'})`,
    );
  }
  return fs.readFileSync(resolvePagePath(snapshot.html_path), 'utf-8');
}

/**
 * ISO timestamps are the natural snapshot filename (sortable, and equal to
 * the `fetched_at` column), but colons are hostile in a filename on some
 * filesystems and in plenty of shells. Only the separator changes, so the
 * name still reads as the timestamp it is.
 */
function timestampToFileBaseName(iso: string): string {
  return iso.replace(/:/g, '-');
}

/**
 * Write-then-link, so a crash mid-write can't leave a truncated file that a
 * `page_snapshots` row claims to be the hashed content.
 */
function writeTempFile(dir: string, contents: string): string {
  const tempPath = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tempPath, contents, 'utf-8');
  return tempPath;
}

/**
 * Claims a free `<base>.html`/`<base>.txt` pair for the two already-written
 * temp files, and returns the base name it won.
 *
 * Two fetches of the same URL within the same millisecond — a closure check
 * and a structural fetch run on different worker topics, so they really can
 * overlap — would otherwise pick the same filename. `link()` fails with
 * EEXIST rather than overwriting, which makes the claim atomic: an
 * existsSync check followed by a write is a race, and losing it would mean
 * one snapshot's row pointing at another snapshot's content. These files
 * are append-only; nothing may ever land on top of an existing one.
 */
function claimSnapshotFileNames(dir: string, base: string, htmlTemp: string, textTemp: string): string {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const htmlPath = path.join(dir, `${candidate}.html`);
    const textPath = path.join(dir, `${candidate}.txt`);

    try {
      fs.linkSync(htmlTemp, htmlPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      continue;
    }

    try {
      fs.linkSync(textTemp, textPath);
      return candidate;
    } catch (error) {
      // The .html name was free but the .txt one wasn't: back out the link
      // we just made (ours, so safe to remove) and try the next suffix.
      fs.rmSync(htmlPath, { force: true });
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  throw new Error(`Could not claim a free snapshot filename in ${dir} for ${base}`);
}

function writeSnapshotFiles(urlHash: string, fetchedAt: string, html: string, text: string): SnapshotFilePaths {
  const relativeDir = path.join('pages', urlHash);
  const dir = path.join(getDataDir(), relativeDir);
  fs.mkdirSync(dir, { recursive: true });

  const htmlTemp = writeTempFile(dir, html);
  try {
    const textTemp = writeTempFile(dir, text);
    try {
      const base = claimSnapshotFileNames(dir, timestampToFileBaseName(fetchedAt), htmlTemp, textTemp);
      return { htmlPath: path.join(relativeDir, `${base}.html`), textPath: path.join(relativeDir, `${base}.txt`) };
    } finally {
      // The temp names are hard links to the same content as the claimed
      // ones; dropping them leaves the snapshot files behind, intact.
      fs.rmSync(textTemp, { force: true });
    }
  } finally {
    fs.rmSync(htmlTemp, { force: true });
  }
}

function snapshotFilesExist(snapshot: PageSnapshotRecord): boolean {
  return (
    snapshot.html_path != null &&
    snapshot.text_path != null &&
    fs.existsSync(resolvePagePath(snapshot.html_path)) &&
    fs.existsSync(resolvePagePath(snapshot.text_path))
  );
}

function isWithinRefreshWindow(snapshot: PageSnapshotRecord, kind: PageKind): boolean {
  const days = loadSettings().page_refresh_days[kind];
  if (!Number.isFinite(days) || days <= 0) return false;

  const fetchedAt = Date.parse(snapshot.fetched_at);
  if (Number.isNaN(fetchedAt)) return false;

  return Date.now() - fetchedAt < days * 24 * 60 * 60 * 1000;
}

/**
 * Fetches a URL and records an immutable snapshot of it — the "sync" half
 * of the build-system model. Returns the snapshot to derive from, which may
 * be an existing one: without `force`, a successful snapshot younger than
 * `settings.page_refresh_days[kind]` is returned as-is and no HTTP request
 * is made at all.
 *
 * A failed fetch still records a row (the attempt is data too) and then
 * rethrows the `FetchError`, so callers that care about *why* — the closure
 * check reading a 404 — keep working exactly as before.
 */
export async function snapshotPage(
  db: Database.Database,
  url: string,
  options: SnapshotPageOptions,
): Promise<PageSnapshotRecord> {
  const urlHash = hashUrl(url);

  if (!options.force) {
    const latest = getLatestSuccessfulSnapshot(db, urlHash);
    // Files missing (a hand-cleared .data/pages) means the row can't be
    // read back from, so it can't stand in for a fetch however young it is.
    if (latest && snapshotFilesExist(latest) && isWithinRefreshWindow(latest, options.kind)) return latest;
  }

  let raw: RawPage;
  try {
    raw = await fetchRawPage(url);
  } catch (error) {
    // Recording the failed attempt must never replace the failure itself:
    // if this insert throws (SQLITE_BUSY under a concurrent writer —
    // enrichment and refresh are separate topics and do overlap), the
    // FetchError and its `.status` would be lost, and the closure check's
    // `instanceof FetchError` test at the other end would misread a real
    // 404 as a transient error and retry the role instead of closing it.
    try {
      insertPageSnapshot(db, {
        url,
        urlHash,
        fetchedAt: new Date().toISOString(),
        httpStatus: error instanceof FetchError ? (error.status ?? null) : null,
        contentHash: null,
        textHash: null,
        bytes: null,
        htmlPath: null,
        textPath: null,
        error,
      });
    } catch {
      // best effort — the fetch failure below is the error that matters
    }
    throw error;
  }

  const fetchedAt = new Date().toISOString();
  const contentHash = sha256(raw.html);
  // Hash what is written, never what was computed: the truncation has to
  // happen before the hash or the .txt on disk stops matching text_hash.
  const text = truncateAtCodePoint(deriveText(raw.html), MAX_TEXT_LENGTH);
  const textHash = sha256(text);

  // An unchanged body records a row — "we checked at T, still the same" is
  // exactly the fact staleness later reads — but reuses the previous files
  // instead of writing a byte-identical copy per check. The text hash has
  // to match too: if `deriveText` itself changed, the old .txt file no
  // longer holds what this row says it holds.
  const previous = getLatestSuccessfulSnapshot(db, urlHash);
  const reusable =
    previous?.content_hash === contentHash && previous?.text_hash === textHash && snapshotFilesExist(previous)
      ? { htmlPath: previous.html_path!, textPath: previous.text_path! }
      : undefined;

  // Files are written before the row, never after: an orphaned file with no
  // row is harmless, a row pointing at a file that was never written is not.
  const paths = reusable ?? writeSnapshotFiles(urlHash, fetchedAt, raw.html, text);

  if (raw.truncated) {
    // Hitting a 5 MB body means something unusual — a listing wall, a data
    // dump, a misconfigured page. Recording it is what keeps a silently
    // half-captured page from looking like a page that was simply short.
    tryRecordOperationalLog(db, {
      severity: 'warn',
      outcome: 'succeeded',
      component: 'pages',
      action: 'snapshot_truncated',
      context: { url, bytes: Buffer.byteLength(raw.html, 'utf-8') },
    });
  }

  return insertPageSnapshot(db, {
    url,
    urlHash,
    fetchedAt,
    httpStatus: raw.status,
    contentHash,
    textHash,
    bytes: Buffer.byteLength(raw.html, 'utf-8'),
    truncated: raw.truncated,
    htmlPath: paths.htmlPath,
    textPath: paths.textPath,
  });
}
