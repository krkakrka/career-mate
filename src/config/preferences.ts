import path from 'node:path';
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

/** Reads .data/config/preferences.json, seeding it with defaults on first access if missing. */
export function loadPreferences(): Preferences {
  return loadJsonConfig(preferencesConfigPath(), DEFAULT_PREFERENCES);
}
