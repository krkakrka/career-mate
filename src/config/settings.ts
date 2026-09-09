import path from 'node:path';
import { loadJsonConfig } from '../lib/json-config.js';
import { getDataDir } from '../lib/paths.js';

export interface Settings {
  recruiter_nudge_days: number;
  stale_days: number;
  reapply_cooldown_months: number;
}

const DEFAULT_SETTINGS: Settings = {
  recruiter_nudge_days: 7,
  stale_days: 14,
  reapply_cooldown_months: 1,
};

export function loadSettings(): Settings {
  return loadJsonConfig(path.join(getDataDir(), 'config', 'settings.json'), DEFAULT_SETTINGS);
}
