/**
 * Coercion helpers for hand-edited config files.
 *
 * `loadJsonConfig` shallow-merges whatever JSON is on disk, so a typo puts
 * an arbitrary value into a typed field. That used to fail a background job
 * at worst; now that priority is scored on the read path, a bad
 * `preferences.json` would take down `cm roles list`, `show` and `add` with
 * an uncaught TypeError. A malformed value falls back to the default rather
 * than propagating — the file is still readable and fixable by hand, which
 * is why `loadJsonConfig` refuses to rewrite it.
 */

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function nullableNumberOr(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function nullableStringOr(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : fallback;
}

export function stringArrayOr(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * A value that must be one of a fixed set.
 *
 * Needed because a misspelled mode is worse than a missing one: an unknown
 * `browser_trace` silently behaving like `always` would fill the data
 * directory with megabyte zips, and behaving like `never` would leave you
 * debugging a failed login with no trace and no explanation.
 */
export function oneOfOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
