import type Database from 'better-sqlite3';
import { tryRecordOperationalLog } from '../db/repositories/operational-logs.js';
import { detectClosurePhrase } from './closure.js';
import { FetchError } from '../pages/fetch.js';
import { readSnapshotText, snapshotPage } from '../pages/store.js';

export type GateVerdict =
  | { track: true; reason: 'open' | 'undetermined' }
  /** Reached the page but could not judge it — distinct from a page that reads as live. */
  | { track: true; reason: 'unreachable'; detail: string }
  | { track: false; reason: 'http-gone' | 'closure-phrase'; detail: string };

/**
 * Whether a discovered URL is worth creating a role for.
 *
 * `discover` asks a model to find postings, and a model will happily surface
 * a URL that 404s or a page that says outright it is no longer accepting
 * applications. Each of those became a tracked role that then paid for a
 * full enrichment chain — a structural extraction *and* a
 * sonnet-with-web-search research call — to describe a posting that does not
 * exist. That is the most expensive way this tool can waste money.
 *
 * **Deliberately free.** Only the two signals that cost nothing are used:
 * HTTP 404/410, and the closure phrase list. `decideClosure` would also ask
 * the model about anything it cannot settle, and paying per candidate to
 * avoid paying per candidate is not a saving — so an undetermined page is
 * tracked, exactly as before this gate existed.
 *
 * The fetch is not extra work either: it writes a snapshot, and the
 * structural enrichment that follows reuses it while it is inside
 * `settings.page_refresh_days.role`. The gate moves a fetch earlier rather
 * than adding one.
 *
 * A transient failure (DNS, a 503, a timeout) returns `undetermined`: losing
 * a real opening to a blip is worse than the enrichment it would have cost,
 * and `cm refresh` will catch it later if it really is dead.
 */
export async function gateDiscoveredUrl(db: Database.Database, url: string): Promise<GateVerdict> {
  let text: string;
  try {
    const snapshot = await snapshotPage(db, url, { kind: 'role' });
    text = readSnapshotText(snapshot);
  } catch (error) {
    if (error instanceof FetchError && (error.status === 404 || error.status === 410)) {
      return { track: false, reason: 'http-gone', detail: `page returned HTTP ${error.status}` };
    }
    // Distinct from "the page did not say": a gate that cannot reach
    // anything is a broken gate, and it would otherwise be invisible —
    // rejections get an event, degradations got silence, while still
    // paying for a fetch per candidate. An outbound proxy starting to
    // refuse connections should be greppable in `cm logs`.
    const detail = error instanceof Error ? error.message : String(error);
    tryRecordOperationalLog(db, {
      severity: 'warn',
      outcome: 'skipped',
      component: 'discover',
      action: 'gate-unreachable',
      context: { url, detail },
    });
    return { track: true, reason: 'unreachable', detail };
  }

  const phrase = detectClosurePhrase(text);
  if (phrase) {
    // Logged at warn, not just recorded as an event: the phrase list
    // decides alone here, with no model fallback, and its own header warns
    // that a false positive silently closes a live role. A company board
    // or multi-posting page containing a sibling role's "this position has
    // been filled" would drop a live opening — and the event lands on the
    // company, which no command shows by default. This makes it greppable.
    tryRecordOperationalLog(db, {
      severity: 'warn',
      outcome: 'skipped',
      component: 'discover',
      action: 'gate-rejected',
      context: { url, phrase },
    });
    return { track: false, reason: 'closure-phrase', detail: `page text contains "${phrase}"` };
  }

  return { track: true, reason: 'open' };
}
