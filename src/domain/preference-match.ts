import type { Preferences } from '../config/preferences.js';

/**
 * Whether a discovered role's title is worth tracking, per the user's
 * preference profile. Deliberately title-only: remote/EU eligibility and
 * salary floor (the rest of `Preferences`) aren't knowable from a title
 * alone — those get checked later, after structural fetch/research enrich
 * the role. An empty `titleKeywords` list matches everything (no filter
 * configured yet).
 */
export function matchesPreferences(title: string | null, preferences: Preferences): boolean {
  if (preferences.titleKeywords.length === 0) return true;
  if (!title) return false;
  const lower = title.toLowerCase();
  return preferences.titleKeywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}
