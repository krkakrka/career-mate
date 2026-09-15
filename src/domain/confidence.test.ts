import { describe, expect, it } from 'vitest';
import { confidenceWeight, shrinkToNeutral } from './confidence.js';

describe('shrinkToNeutral', () => {
  it('uses a well-sourced score as given', () => {
    expect(shrinkToNeutral(0.9, 'high')).toBeCloseTo(0.9, 6);
    expect(shrinkToNeutral(0.1, 'high')).toBeCloseTo(0.1, 6);
  });

  it('pulls a poorly-sourced score toward neutral without discarding it', () => {
    // Shrinkage, not a threshold: a low-confidence signal is still the only
    // WLB evidence most companies have, and throwing it away would be its
    // own kind of dishonesty.
    expect(shrinkToNeutral(0.9, 'low')).toBeCloseTo(0.6, 6);
    expect(shrinkToNeutral(0.1, 'low')).toBeCloseTo(0.4, 6);
    expect(shrinkToNeutral(0.9, 'medium')).toBeCloseTo(0.74, 6);
  });

  it('leaves a neutral score alone at every confidence', () => {
    for (const confidence of ['high', 'medium', 'low', null]) {
      expect(shrinkToNeutral(0.5, confidence), String(confidence)).toBeCloseTo(0.5, 6);
    }
  });

  it('treats an unstated confidence as the lowest, not the highest', () => {
    // Rows predating the column, and a model that declined to say. An
    // unstated confidence is not a high one.
    expect(confidenceWeight(null)).toBe(confidenceWeight('low'));
    expect(confidenceWeight(undefined)).toBe(confidenceWeight('low'));
    expect(confidenceWeight('extremely')).toBe(confidenceWeight('low'));
    expect(shrinkToNeutral(1, null)).toBeCloseTo(0.625, 6);
  });

  it('is not fooled by an inherited property name', () => {
    // `WEIGHTS[x] ?? low` returned a *function* for `constructor`,
    // `toString` and friends — `??` never fires — so `shrinkToNeutral` gave
    // NaN, which became the role's whole priority score and sorted
    // unpredictably through every list view. `wlb_confidence` is
    // unconstrained TEXT, so a restored backup or a hand-edited row really
    // can hold one of these.
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(confidenceWeight(key), key).toBe(confidenceWeight('low'));
      expect(Number.isNaN(shrinkToNeutral(0.2, key)), key).toBe(false);
    }
  });

  it('never leaves the 0-1 range it was given', () => {
    for (const score of [0, 0.25, 0.5, 0.75, 1]) {
      for (const confidence of ['high', 'medium', 'low']) {
        const result = shrinkToNeutral(score, confidence);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }
    }
  });
});
