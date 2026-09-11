import path from 'node:path';
import { loadJsonConfig } from '../lib/json-config.js';
import { getDataDir } from '../lib/paths.js';

/** How old a page snapshot may be before a fetch takes a new one, per kind of page. */
export interface PageRefreshDays {
  /** Role postings change (and close) often, so they're re-snapshotted aggressively. */
  role: number;
  /** Company homepages are near-static; re-fetching them weekly would be pure waste. */
  company: number;
}

export interface Settings {
  recruiter_nudge_days: number;
  stale_days: number;
  reapply_cooldown_months: number;
  page_refresh_days: PageRefreshDays;
  /** Per-`claude` call spend ceiling, passed through to the enrichment scripts. */
  claude_max_budget_usd: number;
  /** Hard kill for a single `claude` call. Enrichment concurrency is 1, so one hung call stalls every other enrichment. */
  claude_timeout_seconds: number;
  /**
   * Floor on how often reading an entity may queue a paid recompute of the
   * same field group. Job pages carry churning text ("Posted 3 days ago",
   * applicant counters), and the closure check re-snapshots on every run —
   * so without a floor, every `cm roles list` could queue a fresh paid
   * extraction for every such role, forever.
   */
  recompute_min_interval_minutes: number;
}

const DEFAULT_SETTINGS: Settings = {
  recruiter_nudge_days: 7,
  stale_days: 14,
  reapply_cooldown_months: 1,
  page_refresh_days: { role: 3, company: 30 },
  claude_max_budget_usd: 0.5,
  claude_timeout_seconds: 180,
  recompute_min_interval_minutes: 60,
};

/**
 * A hand-edited settings.json can contain anything. A non-numeric value
 * here is not cosmetic: `claude_timeout_seconds: "abc"` makes every
 * extraction time out on the next tick, and `claude_max_budget_usd: null`
 * is passed to the CLI as the literal string "null", which it rejects — so
 * every call fails, on a typo, with no obvious cause.
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function loadSettings(): Settings {
  const settings = loadJsonConfig(path.join(getDataDir(), 'config', 'settings.json'), DEFAULT_SETTINGS);

  // loadJsonConfig merges shallowly, which is right for the flat keys but
  // would let a hand-edited `{"page_refresh_days": {"role": 1}}` drop
  // `company` entirely and yield `undefined` days. Re-merge the one nested
  // object so a partial edit means "override this key", not "delete the rest".
  return {
    ...settings,
    page_refresh_days: {
      role: numberOr(settings.page_refresh_days?.role, DEFAULT_SETTINGS.page_refresh_days.role),
      company: numberOr(settings.page_refresh_days?.company, DEFAULT_SETTINGS.page_refresh_days.company),
    },
    recruiter_nudge_days: numberOr(settings.recruiter_nudge_days, DEFAULT_SETTINGS.recruiter_nudge_days),
    stale_days: numberOr(settings.stale_days, DEFAULT_SETTINGS.stale_days),
    reapply_cooldown_months: numberOr(settings.reapply_cooldown_months, DEFAULT_SETTINGS.reapply_cooldown_months),
    claude_max_budget_usd: numberOr(settings.claude_max_budget_usd, DEFAULT_SETTINGS.claude_max_budget_usd),
    claude_timeout_seconds: numberOr(settings.claude_timeout_seconds, DEFAULT_SETTINGS.claude_timeout_seconds),
    recompute_min_interval_minutes: numberOr(
      settings.recompute_min_interval_minutes,
      DEFAULT_SETTINGS.recompute_min_interval_minutes,
    ),
  };
}
