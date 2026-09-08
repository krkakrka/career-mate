const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_LENGTH = 500_000; // ~500KB of HTML is already generous input for extraction; truncate beyond that

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Fetches a page's HTML with script/style tag *contents* stripped (dead
 * weight for extraction — cuts token cost and noise) and truncated to a
 * sane length. No JS execution, no auth — this is the plain-HTTP path for
 * public pages; login-gated sources go through Playwright in a later step.
 */
export async function fetchPageContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'career-mate/0.1 (personal job-search tracker)' },
    });
  } catch (error) {
    throw new FetchError(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new FetchError(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const html = await response.text();
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  return stripped.length > MAX_CONTENT_LENGTH ? stripped.slice(0, MAX_CONTENT_LENGTH) : stripped;
}
