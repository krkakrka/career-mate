import { fileURLToPath } from 'node:url';
import {
  COMPANY_PREFILL_RULES_VERSION,
  ROLE_PREFILL_RULES_VERSION,
  ROLE_RESEARCH_PREFILL_RULES_VERSION,
} from './structural.js';
import { getSourceRecipe } from '../enrichment/sources.js';
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
 * Bump when `research-web.sh` changes what a prompt *says*.
 *
 * Hand-maintained rather than a file hash, for the reason the prefill
 * versions already are: a hash fires on a refactor that produces a
 * byte-identical prompt, and re-researching every tracked entity costs real
 * money. Splitting the shared scale guidance into a per-field block did
 * exactly that — the company prompt reassembled identically, and hashing
 * the file would have queued a paid re-research for all ~90 companies to
 * reproduce answers they already had.
 *
 * The version is the claim "the prompt changed". If you edit the script and
 * the generated prompt is not byte-identical, bump it.
 */
export const RESEARCH_SCRIPT_VERSION = 1;

/** The `sources.json` key each research kind reads its instructions from. */
const RESEARCH_SOURCE_KEYS = { role: 'role_research', company: 'company_research', wlb: 'company_wlb' } as const;

/**
 * The research prompt wrapper, the per-source `instructions` it wraps, and
 * — for roles — the deterministic rules that now answer some of its fields.
 *
 * Per entity kind for the same reason `structuralRecipeVersion` is: the
 * role prefill changing must not mark every company's research derivation
 * stale and pay to redo it.
 *
 * Only *this kind's* instructions go in, not a hash of the whole
 * `sources.json`. The file holds all three recipes, so hashing it meant
 * rewriting the WLB instructions also invalidated every role and company
 * research derivation — three kinds re-researched to change one.
 */
export function researchRecipeVersion(entity: 'role' | 'company' | 'wlb'): string {
  const extra = entity === 'role' ? [`role-research-prefill-rules@${ROLE_RESEARCH_PREFILL_RULES_VERSION}`] : [];
  const instructions = getSourceRecipe(RESEARCH_SOURCE_KEYS[entity]).instructions;
  return combinedRecipeVersion([], [`research-script@${RESEARCH_SCRIPT_VERSION}`, entity, instructions, ...extra]);
}
