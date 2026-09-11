import { fileURLToPath } from 'node:url';
import { PREFILL_RULES_VERSION } from './structural.js';
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

/** The free prefill rules, then the extraction prompt. */
export function structuralRecipeVersion(): string {
  return combinedRecipeVersion([structuralScript], [`prefill-rules@${PREFILL_RULES_VERSION}`]);
}

/** The research prompt wrapper, plus the per-source `instructions` it wraps. */
export function researchRecipeVersion(): string {
  return combinedRecipeVersion([researchWebScript, sourcesPath]);
}
