import type Database from 'better-sqlite3';
import type { EnrichmentJobPayload } from '../daemon/handlers/enrichment.js';
import { loadSettings } from '../config/settings.js';
import type { Company } from '../db/repositories/companies.js';
import { getDerivation, type DerivationKind } from '../db/repositories/derivations.js';
import { enqueueJobOnce } from '../db/repositories/jobs.js';
import { getLatestSuccessfulSnapshot } from '../db/repositories/page-snapshots.js';
import type { Role } from '../db/repositories/roles.js';
import {
  companyResearchPayload,
  companyStructuralPayload,
  companyWlbPayload,
  roleResearchPayload,
  roleStructuralPayload,
} from '../domain/enrichment-payload.js';
import type { EntityType } from '../domain/entity-type.js';
import { buildCompanyResearchContext } from '../enrichment/research-context.js';
import { roleResearchSourceKey } from './role-research-key.js';
import { hashUrl } from '../pages/store.js';
import { contextKey, type DerivationKey } from './keys.js';
import { researchRecipeVersion, structuralRecipeVersion } from './recipes.js';
import { isStale, type StalenessReason } from './staleness.js';

/**
 * The recipe hashes for one command, computed once.
 *
 * Each of these reads a script (and `sources.json`) off disk and hashes it.
 * Called per row, a `cm roles list` over 200 roles does 600 file reads and
 * hashes — the exact per-row cost the surrounding code hoists weights and
 * settings out of the loop to avoid.
 */
export interface RecipeVersions {
  roleStructural: string;
  companyStructural: string;
  roleResearch: string;
  companyResearch: string;
  companyWlb: string;
}

export function currentRecipeVersions(): RecipeVersions {
  return {
    roleStructural: structuralRecipeVersion('role'),
    companyStructural: structuralRecipeVersion('company'),
    roleResearch: researchRecipeVersion('role'),
    companyResearch: researchRecipeVersion('company'),
    companyWlb: researchRecipeVersion('wlb'),
  };
}

export interface FieldGroupStatus {
  kind: DerivationKind;
  reason: StalenessReason;
  /**
   * What to print beside the group's values. "Never computed" is not the
   * same user-facing situation as "computed, then the input changed" — the
   * first is a job that has not run yet (on a freshly added entity it is
   * the normal state), the second is a value on screen that is now known
   * to be out of date.
   */
  marker: '(pending)' | '(stale)';
}

function markerFor(reason: StalenessReason): FieldGroupStatus['marker'] {
  return reason === 'never-computed' ? '(pending)' : '(stale)';
}

/**
 * The current key for a derivation computed from a page: the newest
 * snapshot's text hash, plus the hash of the script that reads it.
 *
 * Undefined when nothing has been fetched yet — which is not staleness.
 * There is no input to be inconsistent with, and a recompute would have
 * nothing to read.
 */
function pageKey(db: Database.Database, url: string, recipeVersion: string): DerivationKey | undefined {
  const snapshot = getLatestSuccessfulSnapshot(db, hashUrl(url));
  if (!snapshot?.text_hash) return undefined;
  return { sourceKey: snapshot.text_hash, recipeVersion };
}

function statusFor(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  current: DerivationKey | undefined,
): FieldGroupStatus | undefined {
  const verdict = isStale(db, entityType, entityId, kind, current);
  if (!verdict.stale || !verdict.reason) return undefined;
  return { kind, reason: verdict.reason, marker: markerFor(verdict.reason) };
}

/**
 * Which of a company's displayed field groups no longer match their inputs.
 *
 * `company_wlb` was excluded while its input came from an authenticated
 * browser fetch — the key could not be computed without doing the fetch,
 * and fetching to render a list defeats the point of checking laziness by
 * hash. It now reads public sources through the same research script as the
 * others, so its key is the same cheap pair, and leaving it out meant a
 * changed WLB prompt was never detected and never requeued.
 */
export function companyFieldGroupStatus(
  db: Database.Database,
  company: Company,
  recipes: RecipeVersions = currentRecipeVersions(),
): FieldGroupStatus[] {
  return [
    statusFor(db, 'company', company.id, 'company_structural', pageKey(db, company.url, recipes.companyStructural)),
    statusFor(db, 'company', company.id, 'company_research', {
      sourceKey: contextKey(buildCompanyResearchContext(company)),
      recipeVersion: recipes.companyResearch,
    }),
    // Same context, different recipe — the two ask the model different
    // questions about the same company.
    statusFor(db, 'company', company.id, 'company_wlb', {
      sourceKey: contextKey(buildCompanyResearchContext(company)),
      recipeVersion: recipes.companyWlb,
    }),
  ].filter((status): status is FieldGroupStatus => status !== undefined);
}

export function roleFieldGroupStatus(
  db: Database.Database,
  role: Role,
  recipes: RecipeVersions = currentRecipeVersions(),
): FieldGroupStatus[] {
  return [
    statusFor(db, 'role', role.id, 'role_structural', pageKey(db, role.url, recipes.roleStructural)),
    // Must be the *same* key the handler writes — context plus prefill.
    // Hashing the context alone here made every researched field read
    // `(stale)` forever and queued a recompute on every read.
    statusFor(db, 'role', role.id, 'role_research', {
      sourceKey: roleResearchSourceKey(db, role),
      recipeVersion: recipes.roleResearch,
    }),
  ].filter((status): status is FieldGroupStatus => status !== undefined);
}

/** The enrichment job that recomputes a given field group. */
function recomputePayload(kind: DerivationKind, entityId: number): EnrichmentJobPayload | undefined {
  switch (kind) {
    case 'company_structural':
      return companyStructuralPayload(entityId);
    case 'company_research':
      return companyResearchPayload(entityId);
    case 'company_wlb':
      return companyWlbPayload(entityId);
    case 'role_structural':
      return roleStructuralPayload(entityId);
    case 'role_research':
      return roleResearchPayload(entityId);
    default:
      return undefined;
  }
}

/**
 * The structural group a research group reads its inputs from. A research
 * call is given the entity's *already extracted* name/title/description, so
 * running it before structural extraction has happened means searching the
 * web for `{"name":null,"description":null}` — an expensive call on an
 * empty question, whose context hash then differs from the real one, so the
 * proper call that follows is not even skipped. Two paid calls, the first
 * on garbage.
 */
const RESEARCH_PREREQUISITE: Partial<Record<DerivationKind, DerivationKind>> = {
  company_research: 'company_structural',
  // WLB reads the same context as company research, so it needs the same
  // prerequisite. It was previously absent from this map only because it
  // was absent from staleness entirely.
  company_wlb: 'company_structural',
  role_research: 'role_structural',
};

function isReadyToCompute(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
): boolean {
  const prerequisite = RESEARCH_PREREQUISITE[kind];
  return prerequisite === undefined || getDerivation(db, entityType, entityId, prerequisite) !== undefined;
}

/**
 * Whether enough time has passed since this group was last computed to pay
 * for computing it again.
 *
 * Applies **only to `source-changed`**. That is the case the floor exists
 * for: plenty of job pages change text on every fetch ("Posted 3 days ago",
 * an applicant counter, a rotating token rendered as text), and the closure
 * check re-snapshots on every run, so without a floor each `cm roles list`
 * would queue a fresh paid extraction for every such role indefinitely.
 *
 * A `recipe-changed` group is not that. Editing a prompt is a deliberate,
 * one-off act whose whole point is that it takes effect — rate-limiting it
 * meant an edited prompt did nothing for an hour, with no indication why.
 * (Caught by the post-build verification, which expected one recompute per
 * entity after a prompt edit and saw none.)
 */
function isOutsideRecomputeFloor(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  floorMs: number,
  reason: StalenessReason,
): boolean {
  if (reason !== 'source-changed') return true;

  const derivation = getDerivation(db, entityType, entityId, kind);
  if (!derivation) return true; // never computed — nothing to rate-limit
  if (floorMs <= 0) return true;

  const computedAt = Date.parse(derivation.computed_at);
  return Number.isNaN(computedAt) || Date.now() - computedAt >= floorMs;
}

/**
 * Queues a recompute for each out-of-date group, debounced: reading the
 * same entity ten times must leave one job per group, not ten. Returns how
 * many were newly enqueued.
 *
 * Note the payloads deliberately carry no `force` — a recompute is about
 * bringing the derived value in line with the snapshot we already have,
 * not about fetching a new one.
 */
export function enqueueRecomputes(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  groups: FieldGroupStatus[],
  /** Passed in by list views so a settings.json read does not happen once per row. */
  floorMs = loadSettings().recompute_min_interval_minutes * 60 * 1000,
): number {
  let enqueued = 0;
  for (const group of groups) {
    const payload = recomputePayload(group.kind, entityId);
    if (!payload) continue;
    if (!isReadyToCompute(db, entityType, entityId, group.kind)) continue;
    if (!isOutsideRecomputeFloor(db, entityType, entityId, group.kind, floorMs, group.reason)) continue;
    if (enqueueJobOnce(db, { topic: 'enrichment', payload })) enqueued += 1;
  }
  return enqueued;
}

/** The recompute floor in milliseconds, read once so a list view can pass it per row. */
export function recomputeFloorMs(): number {
  return loadSettings().recompute_min_interval_minutes * 60 * 1000;
}

/** Convenience for the print path: `kind -> marker`, so a detail view can suffix the right lines. */
export function markersByKind(groups: FieldGroupStatus[]): Map<DerivationKind, string> {
  return new Map(groups.map((group) => [group.kind, group.marker]));
}
