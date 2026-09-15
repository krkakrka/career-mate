/**
 * How much to believe a researched sentiment score.
 *
 * Only work-life balance uses this today, and it is the one enriched field
 * that cannot be made factual: comp has levels.fyi, remote/EU has the
 * posting's own declaration, IPO status is a matter of record. WLB is a
 * model summarising public discussion, and the difference between a company
 * with a hundred public data points and one with none is the whole story —
 * yet both would otherwise arrive as a bare 0-1 number that moves the
 * priority ranking equally.
 */

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * How far a score at this confidence is allowed to move away from neutral.
 *
 * Shrinkage toward 0.5, not a threshold: a low-confidence signal is still
 * information, and discarding it entirely would throw away the only WLB
 * evidence that exists for most companies. A quarter of its distance from
 * neutral says "this is a hint" without letting a Reddit thread outrank a
 * salary.
 *
 * `null` — a row predating the column, or a model that declined to say —
 * is treated as `low`: an unstated confidence is not a high one.
 */
const WEIGHTS: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.25 };

export function confidenceWeight(confidence: string | null | undefined): number {
  // `Object.hasOwn`, not `WEIGHTS[x] ?? low`: a plain object inherits
  // `constructor`, `toString` and friends, so those keys return a *function*
  // and `??` never fires — `shrinkToNeutral` then yields NaN, which becomes
  // the role's whole priority score and sorts unpredictably through every
  // list view. `wlb_confidence` is unconstrained TEXT, so a restored backup
  // or a hand-edited row can hold anything.
  return typeof confidence === 'string' && Object.hasOwn(WEIGHTS, confidence)
    ? WEIGHTS[confidence as Confidence]
    : WEIGHTS.low;
}

/**
 * A 0-1 score pulled toward neutral by how well-sourced it is.
 *
 * At `high` the score is used as given; at `low` only a quarter of its
 * distance from 0.5 survives.
 */
export function shrinkToNeutral(score: number, confidence: string | null | undefined): number {
  return 0.5 + (score - 0.5) * confidenceWeight(confidence);
}
