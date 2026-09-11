import path from 'node:path';
import { numberOr } from '../lib/config-coerce.js';
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

/**
 * Reads .data/config/scoring.json, seeding it with defaults on first access
 * if missing.
 *
 * Weights are coerced: a non-numeric one would make the whole score NaN,
 * which sorts arbitrarily under `--sort priority` and prints as
 * `priority=NaN` — a silent wrong answer rather than a visible failure.
 */
export function loadScoringWeights(): ScoringWeights {
  const weights = loadJsonConfig(scoringConfigPath(), DEFAULT_WEIGHTS);
  return {
    comp_fit: numberOr(weights.comp_fit, DEFAULT_WEIGHTS.comp_fit),
    remote_eu_match: numberOr(weights.remote_eu_match, DEFAULT_WEIGHTS.remote_eu_match),
    ai_proof: numberOr(weights.ai_proof, DEFAULT_WEIGHTS.ai_proof),
    wlb: numberOr(weights.wlb, DEFAULT_WEIGHTS.wlb),
    preference_match: numberOr(weights.preference_match, DEFAULT_WEIGHTS.preference_match),
    company_preference: numberOr(weights.company_preference, DEFAULT_WEIGHTS.company_preference),
  };
}
