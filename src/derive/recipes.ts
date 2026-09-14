import { fileURLToPath } from 'node:url';
import {
  COMPANY_PREFILL_RULES_VERSION,
  ROLE_PREFILL_RULES_VERSION,
  ROLE_RESEARCH_PREFILL_RULES_VERSION,
} from './structural.js';
import { sourcesPath } from '../enrichment/sources.js';
import { combinedRecipeVersion } from './keys.js';

const structuralScript = fileURLToPath(new URL('../enrichment/scripts/extract-structural.sh', import.meta.url));
const researchWebScript = fileURLToPath(new URL('../enrichment/scripts/research-web.sh', import.meta.url));

/**
 * The recipe identities, in one place.
 *
 * A "recipe" is everything that decides what a derivation produces, not just
 * the file that happens to contain the prompt. The handler and the staleness
 * check must compute these identically — if they ever disagreed, every read
 * would report the value stale and queue a recompute that changes nothing,
 * forever — so neither computes them itself.
 */

/**
 * The free prefill rules, then the extraction prompt.
 *
 * Per entity kind: the two share the extraction script but not the prefill
 * rules, and folding one version in for both means a change to either marks
 * every entity of *both* kinds stale and pays to re-extract them.
 */
export function structuralRecipeVersion(entity: 'role' | 'company'): string {
  const prefill = entity === 'role' ? ROLE_PREFILL_RULES_VERSION : COMPANY_PREFILL_RULES_VERSION;
  return combinedRecipeVersion([structuralScript], [`${entity}-prefill-rules@${prefill}`]);
}

/**
 * The research prompt wrapper, the per-source `instructions` it wraps, and
 * — for roles — the deterministic rules that now answer some of its fields.
 *
 * Per entity kind for the same reason `structuralRecipeVersion` is: the
 * role prefill changing must not mark every company's research derivation
 * stale and pay to redo it.
 */
export function researchRecipeVersion(entity: 'role' | 'company'): string {
  const extra = entity === 'role' ? [`role-research-prefill-rules@${ROLE_RESEARCH_PREFILL_RULES_VERSION}`] : [];
  return combinedRecipeVersion([researchWebScript, sourcesPath], [entity, ...extra]);
}
