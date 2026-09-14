/**
 * The `role_research` derivation key, in one place.
 *
 * Two callers need the identical string: the handler, which writes the
 * derivation, and the staleness check, which hashes what it reads to decide
 * whether the stored value still corresponds to it. When they built it
 * differently the read path could *never* match — `cm roles show` suffixed
 * every researched field with `(stale)` forever, and `enqueueRecomputes`
 * queued a `role-research` job on every read that loaded a snapshot and
 * then hit `skipIfFresh`. That is the failure `research-context.ts`'s
 * header warns about, and the reason the context builder lives in one place
 * too; this module extends the same guarantee to the prefill half that
 * Step 30 added and Step 32 widened.
 */

import type Database from 'better-sqlite3';
import { loadPreferences } from '../config/preferences.js';
import { getLatestSuccessfulSnapshot } from '../db/repositories/page-snapshots.js';
import type { Role } from '../db/repositories/roles.js';
import { buildRoleResearchContext } from '../enrichment/research-context.js';
import { hashUrl, readSnapshotHtml } from '../pages/store.js';
import { contextKey } from './keys.js';
import { prefillRoleResearch, roleResearchPrefillFields, type RoleResearchPrefill } from './structural.js';

/** What a posting with no readable declaration tells us: nothing, and no complaint about it. */
export const NO_ROLE_RESEARCH_PREFILL: RoleResearchPrefill = {
  remoteEu: null,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  salaryDeclined: null,
};

/**
 * The posting's own declaration, from the snapshot the structural pass took.
 *
 * A missing or unreadable snapshot degrades to "declared nothing" rather
 * than throwing: the row can outlive its file (a hand-cleared `.data/pages`,
 * which `snapshotPage` guards for exactly this reason), this runs *before*
 * `skipIfFresh`, and it is also on the read path — so an exception here
 * would permanently fail research for that role through every retry, and
 * take `cm roles show` down with it.
 *
 * `loadPreferences` is deliberately outside that tolerance. `loadJsonConfig`
 * throws on malformed JSON on purpose, so a hand-edit typo is loud; swallowing
 * it here would lose the free prefill silently while `cm roles list` failed
 * on the very same file.
 */
export function readRoleResearchPrefill(db: Database.Database, url: string): RoleResearchPrefill {
  const preferences = loadPreferences();
  let html: string;
  try {
    const snapshot = getLatestSuccessfulSnapshot(db, hashUrl(url));
    if (!snapshot?.html_path) return NO_ROLE_RESEARCH_PREFILL;
    html = readSnapshotHtml(snapshot);
  } catch {
    return NO_ROLE_RESEARCH_PREFILL;
  }
  return prefillRoleResearch(html, preferences);
}

/**
 * What the stored `role_research` derivation must have been computed from.
 *
 * Covers the context *and* the prefill, because `deriveText` strips
 * `<script>`: a posting that later adds or corrects its JSON-LD changes
 * neither `text_hash` nor the context, so keyed on those alone the
 * correction would never be picked up. Keyed on the prefill *result* rather
 * than the raw HTML, so a changed analytics snippet still churns nothing.
 *
 * The prefill is injectable so the handler, which has already read it to
 * decide what to ask the model, does not read the snapshot file twice.
 */
export function roleResearchSourceKey(
  db: Database.Database,
  role: Role,
  prefill: RoleResearchPrefill = readRoleResearchPrefill(db, role.url),
): string {
  return contextKey(`${buildRoleResearchContext(db, role)}\n${JSON.stringify(roleResearchPrefillFields(prefill))}`);
}
