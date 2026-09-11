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
  roleResearchPayload,
  roleStructuralPayload,
} from '../domain/enrichment-payload.js';
import type { EntityType } from '../domain/entity-type.js';
import { buildCompanyResearchContext, buildRoleResearchContext } from '../enrichment/research-context.js';
import { hashUrl } from '../pages/store.js';
import { contextKey, type DerivationKey } from './keys.js';
import { researchRecipeVersion, structuralRecipeVersion } from './recipes.js';
import { isStale, type StalenessReason } from './staleness.js';

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
function pageKey(db: Database.Database, url: string): DerivationKey | undefined {
  const snapshot = getLatestSuccessfulSnapshot(db, hashUrl(url));
  if (!snapshot?.text_hash) return undefined;
  return { sourceKey: snapshot.text_hash, recipeVersion: structuralRecipeVersion() };
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
 * Which of a company's displayed field groups no longer match their
 * inputs. `company_wlb` is deliberately absent: its input comes from an
 * authenticated browser fetch, so the current key cannot be computed
 * without doing the fetch — and doing a fetch to render a list would defeat
 * the point of checking laziness by hash.
 */
export function companyFieldGroupStatus(db: Database.Database, company: Company): FieldGroupStatus[] {
  return [
    statusFor(db, 'company', company.id, 'company_structural', pageKey(db, company.url)),
    statusFor(db, 'company', company.id, 'company_research', {
      sourceKey: contextKey(buildCompanyResearchContext(company)),
      recipeVersion: researchRecipeVersion(),
    }),
  ].filter((status): status is FieldGroupStatus => status !== undefined);
}

export function roleFieldGroupStatus(db: Database.Database, role: Role): FieldGroupStatus[] {
  return [
    statusFor(db, 'role', role.id, 'role_structural', pageKey(db, role.url)),
    statusFor(db, 'role', role.id, 'role_research', {
      sourceKey: contextKey(buildRoleResearchContext(db, role)),
      recipeVersion: researchRecipeVersion(),
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
 * Staleness is honest — the page text really did change — but plenty of job
 * pages change text on every fetch ("Posted 3 days ago", an applicant
 * counter, a rotating token rendered as text), and the closure check
 * re-snapshots on every run. Without a floor, each `cm roles list` would
 * queue a fresh paid extraction for every such role, indefinitely, and the
 * only visible sign would be the spend line.
 */
function isOutsideRecomputeFloor(
  db: Database.Database,
  entityType: EntityType,
  entityId: number,
  kind: DerivationKind,
  floorMs: number,
): boolean {
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
    if (!isOutsideRecomputeFloor(db, entityType, entityId, group.kind, floorMs)) continue;
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
