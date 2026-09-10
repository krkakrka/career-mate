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
}

const DEFAULT_SETTINGS: Settings = {
  recruiter_nudge_days: 7,
  stale_days: 14,
  reapply_cooldown_months: 1,
  page_refresh_days: { role: 3, company: 30 },
  claude_max_budget_usd: 0.5,
};

export function loadSettings(): Settings {
  const settings = loadJsonConfig(path.join(getDataDir(), 'config', 'settings.json'), DEFAULT_SETTINGS);

  // loadJsonConfig merges shallowly, which is right for the flat keys but
  // would let a hand-edited `{"page_refresh_days": {"role": 1}}` drop
  // `company` entirely and yield `undefined` days. Re-merge the one nested
  // object so a partial edit means "override this key", not "delete the rest".
  return { ...settings, page_refresh_days: { ...DEFAULT_SETTINGS.page_refresh_days, ...settings.page_refresh_days } };
}
