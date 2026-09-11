import path from 'node:path';
import { booleanOr, nullableNumberOr, nullableStringOr, stringArrayOr } from '../lib/config-coerce.js';
import { loadJsonConfig } from '../lib/json-config.js';
import { getDataDir } from '../lib/paths.js';

/**
 * Single global preference profile (per the original design — one profile
 * is enough for a single-user tool). Lives under .data/config/ rather than
 * in the repo since it's personal, hand-tuned state, not app code — same
 * reasoning as scoring.ts. `discover` (a later step) will read the fuller
 * shape (titleKeywords, seniority, remoteEuRequired) to filter candidate
 * roles; priority scoring only needs minSalary for now.
 */
export interface Preferences {
  titleKeywords: string[];
  seniority: string | null;
  remoteEuRequired: boolean;
  minSalary: number | null;
}

const DEFAULT_PREFERENCES: Preferences = {
  titleKeywords: [],
  seniority: null,
  remoteEuRequired: false,
  minSalary: null,
};

function preferencesConfigPath(): string {
  return path.join(getDataDir(), 'config', 'preferences.json');
}

/**
 * Reads .data/config/preferences.json, seeding it with defaults on first
 * access if missing.
 *
 * Every field is coerced, because this is now read on the CLI's display
 * path: a hand-edited `{"titleKeywords": null}` would otherwise reach
 * `preferenceMatchTerm` and kill `cm roles list`/`show`/`add` outright.
 */
export function loadPreferences(): Preferences {
  const preferences = loadJsonConfig(preferencesConfigPath(), DEFAULT_PREFERENCES);
  return {
    titleKeywords: stringArrayOr(preferences.titleKeywords, DEFAULT_PREFERENCES.titleKeywords),
    seniority: nullableStringOr(preferences.seniority, DEFAULT_PREFERENCES.seniority),
    remoteEuRequired: booleanOr(preferences.remoteEuRequired, DEFAULT_PREFERENCES.remoteEuRequired),
    minSalary: nullableNumberOr(preferences.minSalary, DEFAULT_PREFERENCES.minSalary),
  };
}
