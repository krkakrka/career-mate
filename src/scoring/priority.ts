import type Database from 'better-sqlite3';
import { loadPreferences, type Preferences } from '../config/preferences.js';
import { loadScoringWeights, type ScoringWeights } from '../config/scoring.js';
import { getCompanyById, type Company } from '../db/repositories/companies.js';
import type { Role } from '../db/repositories/roles.js';

export interface PriorityScoreInputs {
  role: Role;
  company: Company | null;
  weights: ScoringWeights;
  preferences: Preferences;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * 1 if the role clears your salary floor, partial credit approaching it,
 * 0.5 (neutral) if either side is unknown — or if the two are denominated
 * in currencies we know to differ.
 *
 * That last case is not pedantry: these are bare integers, so ¥5,000,000
 * clears a €100,000 floor by a factor of fifty while being about a third of
 * it, and nothing downstream reads the score back to notice. Converting
 * would need a rate that is stale the day after it is written, so a
 * mismatch scores neutral — the same value every other unknown gets.
 *
 * A role with no recorded currency is compared as before. That covers every
 * model-researched figure and every row predating the column; treating
 * those as unknown instead would have silently flattened the comp term for
 * the entire existing database.
 */
function compFitTerm(role: Role, preferences: Preferences): number {
  if (preferences.minSalary == null || role.salary_max == null) return 0.5;
  if (role.salary_currency != null && preferences.currency != null && role.salary_currency !== preferences.currency) {
    return 0.5;
  }
  if (role.salary_max >= preferences.minSalary) return 1;
  return Math.max(0, role.salary_max / preferences.minSalary);
}

function remoteEuMatchTerm(role: Role): number {
  if (role.remote_eu === 'yes') return 1;
  if (role.remote_eu === 'no') return 0;
  return 0.5; // unknown
}

/** ai_proof_score/wlb_score are stored 0 (worst) .. 1 (best); clamped defensively in case a research pass ever returns out-of-range. */
function aiProofTerm(company: Company | null): number {
  if (company?.ai_proof_score == null) return 0.5;
  return clamp01(company.ai_proof_score);
}

function wlbTerm(company: Company | null): number {
  if (company?.wlb_score == null) return 0.5;
  return clamp01(company.wlb_score);
}

/** Minimal for now: does the role title contain any preferred keyword. Richer matching (seniority, etc.) belongs to discover, a later step. */
function preferenceMatchTerm(role: Role, preferences: Preferences): number {
  if (preferences.titleKeywords.length === 0) return 0.5;
  if (!role.title) return 0.5;
  const title = role.title.toLowerCase();
  const matched = preferences.titleKeywords.some((keyword) => title.includes(keyword.toLowerCase()));
  return matched ? 1 : 0;
}

/** company.preference_rating is -2..2 (manual); mapped to 0..1 to sit on the same scale as the other terms. */
function companyPreferenceTerm(company: Company | null): number {
  if (!company) return 0.5;
  return (company.preference_rating + 2) / 4;
}

/** Weighted sum (not average — absolute magnitude depends on the weights chosen; only used for relative ranking/sorting). */
export function computePriorityScore(inputs: PriorityScoreInputs): number {
  const { role, company, weights, preferences } = inputs;
  const terms: [number, number][] = [
    [weights.comp_fit, compFitTerm(role, preferences)],
    [weights.remote_eu_match, remoteEuMatchTerm(role)],
    [weights.ai_proof, aiProofTerm(company)],
    [weights.wlb, wlbTerm(company)],
    [weights.preference_match, preferenceMatchTerm(role, preferences)],
    [weights.company_preference, companyPreferenceTerm(company)],
  ];
  return terms.reduce((sum, [weight, term]) => sum + weight * term, 0);
}

/**
 * The score for one role, read straight from current data.
 *
 * Loaders are passed in rather than read here so a caller listing 200 roles
 * reads `scoring.json`/`preferences.json` once, not once per row.
 */
export function scoreRole(
  db: Database.Database,
  role: Role,
  weights: ScoringWeights,
  preferences: Preferences,
): number {
  const company = role.company_id != null ? (getCompanyById(db, role.company_id) ?? null) : null;
  return computePriorityScore({ role, company, weights, preferences });
}

/** Convenience for the single-entity views, where loading the config once per call is free. */
export function scoreRoleWithConfig(db: Database.Database, role: Role): number {
  return scoreRole(db, role, loadScoringWeights(), loadPreferences());
}
