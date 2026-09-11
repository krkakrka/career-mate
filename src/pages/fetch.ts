import { truncateAtCodePoint } from '../lib/truncate.js';

const FETCH_TIMEOUT_MS = 15_000;
/**
 * A guard against a runaway response eating memory and disk — no longer a
 * budget for model input, which is now the derived text.
 *
 * The old 500 KB cap was applied *after* script/style contents were
 * stripped, so it bounded 500 KB of actual content. Snapshots are raw, so
 * the same number applied to a raw body would be spent on an SPA's inline
 * bootstrap JSON (a Workday or Next.js posting can carry hundreds of KB of
 * `__NEXT_DATA__` in <head> alone), truncating the job description away
 * before `deriveText` ever gets to strip the JS — leaving a near-empty
 * text and a silently useless extraction.
 */
export const MAX_CONTENT_LENGTH = 5_000_000;

export class FetchError extends Error {
  /** The HTTP status code, when the failure was a non-ok response (vs. a network-level failure, where this is undefined). */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

export interface RawPage {
  status: number;
  /** The response body exactly as served, truncated at MAX_CONTENT_LENGTH. */
  html: string;
  truncated: boolean;
}

/**
 * Reads the body but stops once the cap is reached.
 *
 * `response.text()` buffers the whole body first, so the cap would bound
 * only what gets stored and hashed — never what gets allocated. A hostile
 * or misconfigured endpoint streaming hundreds of MB inside the abort
 * window would OOM the daemon, which (via `uncaughtException`) takes the
 * whole daemon down. Reading the stream is what makes the cap the memory
 * guard it claims to be.
 */
async function readCapped(response: Response): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: await response.text(), truncated: false };

  const decoder = new TextDecoder('utf-8');
  const reader = response.body.getReader();
  let body = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character split across chunk
      // boundaries intact — decoding each chunk alone yields U+FFFD.
      body += decoder.decode(value, { stream: true });
      if (body.length > MAX_CONTENT_LENGTH) {
        await reader.cancel();
        return { body, truncated: true };
      }
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return { body, truncated: false };
}

/**
 * Fetches a page's HTML over plain HTTP — no JS execution, no auth. The
 * body is returned unmodified (beyond the length cap): this is the raw
 * source a snapshot stores and hashes, so stripping anything here would
 * make the file on disk a lie about what the server served. Noise removal
 * happens in the text derivation instead (`deriveText`).
 */
export async function fetchRawPage(url: string): Promise<RawPage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'career-mate/0.1 (personal job-search tracker)' },
    });

    if (!response.ok) {
      throw new FetchError(`Failed to fetch ${url}: HTTP ${response.status}`, response.status);
    }

    const { body, truncated } = await readCapped(response);
    return { status: response.status, html: truncateAtCodePoint(body, MAX_CONTENT_LENGTH), truncated };
  } catch (error) {
    // Re-throw our own status-bearing error untouched; only wrap the
    // network/abort-level failures, which carry no status.
    if (error instanceof FetchError) throw error;
    throw new FetchError(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}
