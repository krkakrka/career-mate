import type Database from 'better-sqlite3';
import { loadPreferences, type Preferences } from '../config/preferences.js';
import { loadScoringWeights, type ScoringWeights } from '../config/scoring.js';
import { getCompanyById, type Company } from '../db/repositories/companies.js';
import { getRoleById, listRoleIdsForCompany, type Role } from '../db/repositories/roles.js';

export interface PriorityScoreInputs {
  role: Role;
  company: Company | null;
  weights: ScoringWeights;
  preferences: Preferences;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 1 if the role clears your salary floor, partial credit approaching it, 0.5 (neutral) if either side is unknown. */
function compFitTerm(role: Role, preferences: Preferences): number {
  if (preferences.minSalary == null || role.salary_max == null) return 0.5;
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

function persistScore(db: Database.Database, roleId: number, score: number): void {
  db.prepare(
    "UPDATE roles SET priority_score = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(score, roleId);
}

/** Recomputes and persists priority_score for one role — call after anything that changes its own data (structural fetch, comp/equity/remote-EU research). */
export function recomputePriorityForRole(db: Database.Database, roleId: number): void {
  const role = getRoleById(db, roleId);
  if (!role) return;
  const company = role.company_id != null ? (getCompanyById(db, role.company_id) ?? null) : null;
  const score = computePriorityScore({
    role,
    company,
    weights: loadScoringWeights(),
    preferences: loadPreferences(),
  });
  persistScore(db, roleId, score);
}

/** Recomputes every role at a company — call after anything that changes company-level data (structural fetch, IPO/AI-proof/WLB research, manual preference rating). */
export function recomputePriorityForCompanyRoles(db: Database.Database, companyId: number): void {
  for (const roleId of listRoleIdsForCompany(db, companyId)) {
    recomputePriorityForRole(db, roleId);
  }
}
