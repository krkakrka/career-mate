import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { loadPreferences } from '../config/preferences.js';
import { loadScoringWeights } from '../config/scoring.js';
import { computePriorityScore } from '../scoring/priority.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-coerce-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeConfig(name: string, contents: unknown): void {
  const dir = path.join(tempDir, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(contents));
}

/**
 * Priority is scored on the read path now, so a hand-edited config no
 * longer fails a background job at worst — it can take down `cm roles
 * list`, `show` and `add` outright.
 */
describe('hand-edited config cannot crash a read', () => {
  it('falls back when a preference field has the wrong type', () => {
    writeConfig('preferences.json', { titleKeywords: null, minSalary: 'lots', remoteEuRequired: 'yes' });

    const preferences = loadPreferences();

    expect(preferences.titleKeywords).toEqual([]);
    expect(preferences.minSalary).toBeNull();
    expect(preferences.remoteEuRequired).toBe(false);
  });

  it('keeps the usable entries of a partly-bad keyword list', () => {
    writeConfig('preferences.json', { titleKeywords: ['engineer', 7, null, 'staff'] });
    expect(loadPreferences().titleKeywords).toEqual(['engineer', 'staff']);
  });

  it('preserves a deliberate null, which is a real configured value', () => {
    writeConfig('preferences.json', { minSalary: null, seniority: null });
    expect(loadPreferences().minSalary).toBeNull();
    expect(loadPreferences().seniority).toBeNull();
  });

  it('falls back on a non-numeric weight instead of scoring everything NaN', () => {
    writeConfig('scoring.json', { comp_fit: 'high', wlb: null });

    const weights = loadScoringWeights();

    expect(weights.comp_fit).toBe(1);
    expect(weights.wlb).toBe(1);
    // NaN would sort arbitrarily under --sort priority and print as
    // `priority=NaN`: a silent wrong answer rather than a visible failure.
    const score = computePriorityScore({
      role: { salary_min: null, salary_max: null, remote_eu: null, title: null } as never,
      company: null,
      weights,
      preferences: loadPreferences(),
    });
    expect(Number.isNaN(score)).toBe(false);
  });
});
