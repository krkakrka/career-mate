const FETCH_TIMEOUT_MS = 15_000;
/** ~500KB of HTML is already generous input for extraction; anything past it is boilerplate or a runaway page. */
const MAX_CONTENT_LENGTH = 500_000;

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
 * Truncates without splitting a surrogate pair. A bare `slice` cuts by
 * UTF-16 code unit, so a cut landing between the halves of an astral
 * character (an emoji in a job posting is enough) leaves a lone surrogate:
 * legal in a JS string and hashable, but written to disk as UTF-8 it
 * becomes U+FFFD — and then the bytes on disk no longer hash to the
 * `content_hash` recorded beside them, which is the one guarantee the
 * whole page store rests on.
 */
function truncateAtCodePoint(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const lastUnit = value.charCodeAt(maxLength - 1);
  const splitsSurrogatePair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return value.slice(0, splitsSurrogatePair ? maxLength - 1 : maxLength);
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

    const body = await response.text();
    const truncated = body.length > MAX_CONTENT_LENGTH;
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
