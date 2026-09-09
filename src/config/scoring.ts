import path from 'node:path';
import { loadJsonConfig } from '../lib/json-config.js';
import { getDataDir } from '../lib/paths.js';

/** Weights for priority.ts's weighted-sum formula. Ships with equal weights as placeholders — tune once real enriched data exists. */
export interface ScoringWeights {
  comp_fit: number;
  remote_eu_match: number;
  ai_proof: number;
  wlb: number;
  preference_match: number;
  company_preference: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  comp_fit: 1,
  remote_eu_match: 1,
  ai_proof: 1,
  wlb: 1,
  preference_match: 1,
  company_preference: 1,
};

function scoringConfigPath(): string {
  return path.join(getDataDir(), 'config', 'scoring.json');
}

/** Reads .data/config/scoring.json, seeding it with defaults on first access if missing. */
export function loadScoringWeights(): ScoringWeights {
  return loadJsonConfig(scoringConfigPath(), DEFAULT_WEIGHTS);
}
