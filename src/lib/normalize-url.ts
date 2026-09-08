/**
 * Normalizes a URL for loose duplicate/identity comparison: lowercased
 * host, path with trailing slash stripped, query/hash ignored. Shared by
 * role duplicate detection and company resolution-by-URL — both are
 * answering the same underlying question ("is this the same thing I
 * already have a URL for"), so they should agree on what "the same" means.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
