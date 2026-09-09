import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Preferences } from '../config/preferences.js';
import type { ScoringWeights } from '../config/scoring.js';
import { openDb } from '../db/client.js';
import { createCompany, getCompanyById, setPreferenceRating } from '../db/repositories/companies.js';
import { createRole, getRoleById } from '../db/repositories/roles.js';
import { computePriorityScore, recomputePriorityForCompanyRoles, recomputePriorityForRole } from './priority.js';

const EQUAL_WEIGHTS: ScoringWeights = {
  comp_fit: 1,
  remote_eu_match: 1,
  ai_proof: 1,
  wlb: 1,
  preference_match: 1,
  company_preference: 1,
};

const NO_PREFERENCES: Preferences = {
  titleKeywords: [],
  seniority: null,
  remoteEuRequired: false,
  minSalary: null,
};

function baseRole(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    company_id: null,
    url: 'https://example.com/jobs/1',
    title: null,
    description: null,
    status: 'new' as const,
    status_changed_at: '2026-01-01T00:00:00.000Z',
    reapply_after: null,
    salary_min: null,
    salary_max: null,
    equity: null,
    remote_eu: null,
    priority_score: null,
    closed_at: null,
    last_checked_at: null,
    last_enriched_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    url: 'https://example.com',
    name: 'Example Co',
    description: null,
    preference_rating: 0,
    connections: null,
    ipo_status: null,
    ai_proof_score: null,
    ai_proof_notes: null,
    wlb_score: null,
    wlb_notes: null,
    last_enriched_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computePriorityScore — all-unknown baseline', () => {
  it('with no company and no data, every neutral (0.5) term contributes equally, comp_fit and preference_match too since no preferences set', () => {
    // remote_eu unknown (0.5), ai_proof unknown (0.5), wlb unknown (0.5),
    // comp_fit neutral since minSalary unset (0.5), preference_match
    // neutral since no keywords set (0.5), company_preference neutral
    // since no company (0.5) -> 6 * 0.5 * weight(1) = 3
    const score = computePriorityScore({
      role: baseRole() as never,
      company: null,
      weights: EQUAL_WEIGHTS,
      preferences: NO_PREFERENCES,
    });
    expect(score).toBeCloseTo(3, 5);
  });
});

describe('computePriorityScore — comp_fit', () => {
  it('scores 1 when salary_max clears the preference floor', () => {
    const score = computePriorityScore({
      role: baseRole({ salary_max: 200_000 }) as never,
      company: null,
      weights: { ...EQUAL_WEIGHTS, comp_fit: 1, remote_eu_match: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 },
      preferences: { ...NO_PREFERENCES, minSalary: 150_000 },
    });
    expect(score).toBeCloseTo(1, 5);
  });

  it('gives partial credit below the floor, proportional to how close it is', () => {
    const score = computePriorityScore({
      role: baseRole({ salary_max: 100_000 }) as never,
      company: null,
      weights: { ...EQUAL_WEIGHTS, comp_fit: 1, remote_eu_match: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 },
      preferences: { ...NO_PREFERENCES, minSalary: 200_000 },
    });
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('is neutral (0.5) when salary is unknown even if a floor is set', () => {
    const score = computePriorityScore({
      role: baseRole({ salary_max: null }) as never,
      company: null,
      weights: { ...EQUAL_WEIGHTS, comp_fit: 1, remote_eu_match: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 },
      preferences: { ...NO_PREFERENCES, minSalary: 150_000 },
    });
    expect(score).toBeCloseTo(0.5, 5);
  });
});

describe('computePriorityScore — remote_eu_match', () => {
  const weights = { ...EQUAL_WEIGHTS, comp_fit: 0, remote_eu_match: 1, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 };

  it('scores 1 for yes, 0 for no, 0.5 for unknown', () => {
    expect(
      computePriorityScore({ role: baseRole({ remote_eu: 'yes' }) as never, company: null, weights, preferences: NO_PREFERENCES }),
    ).toBeCloseTo(1, 5);
    expect(
      computePriorityScore({ role: baseRole({ remote_eu: 'no' }) as never, company: null, weights, preferences: NO_PREFERENCES }),
    ).toBeCloseTo(0, 5);
    expect(
      computePriorityScore({ role: baseRole({ remote_eu: null }) as never, company: null, weights, preferences: NO_PREFERENCES }),
    ).toBeCloseTo(0.5, 5);
  });
});

describe('computePriorityScore — ai_proof / wlb', () => {
  const weights = { ...EQUAL_WEIGHTS, comp_fit: 0, remote_eu_match: 0, ai_proof: 1, wlb: 1, preference_match: 0, company_preference: 0 };

  it('uses the stored 0..1 score directly, and is neutral when null', () => {
    const withScores = computePriorityScore({
      role: baseRole() as never,
      company: baseCompany({ ai_proof_score: 0.8, wlb_score: 0.2 }) as never,
      weights,
      preferences: NO_PREFERENCES,
    });
    expect(withScores).toBeCloseTo(0.8 + 0.2, 5);

    const withoutScores = computePriorityScore({
      role: baseRole() as never,
      company: baseCompany({ ai_proof_score: null, wlb_score: null }) as never,
      weights,
      preferences: NO_PREFERENCES,
    });
    expect(withoutScores).toBeCloseTo(1, 5); // 0.5 + 0.5
  });

  it('clamps an out-of-range score defensively', () => {
    const score = computePriorityScore({
      role: baseRole() as never,
      company: baseCompany({ ai_proof_score: 1.5, wlb_score: -0.5 }) as never,
      weights,
      preferences: NO_PREFERENCES,
    });
    expect(score).toBeCloseTo(1 + 0, 5);
  });
});

describe('computePriorityScore — preference_match', () => {
  const weights = { ...EQUAL_WEIGHTS, comp_fit: 0, remote_eu_match: 0, ai_proof: 0, wlb: 0, preference_match: 1, company_preference: 0 };

  it('matches a keyword case-insensitively', () => {
    const score = computePriorityScore({
      role: baseRole({ title: 'Senior Backend Engineer' }) as never,
      company: null,
      weights,
      preferences: { ...NO_PREFERENCES, titleKeywords: ['backend'] },
    });
    expect(score).toBeCloseTo(1, 5);
  });

  it('scores 0 when keywords are set but none match', () => {
    const score = computePriorityScore({
      role: baseRole({ title: 'Marketing Manager' }) as never,
      company: null,
      weights,
      preferences: { ...NO_PREFERENCES, titleKeywords: ['backend', 'infrastructure'] },
    });
    expect(score).toBeCloseTo(0, 5);
  });

  it('is neutral when no keywords are configured, or title is not yet known', () => {
    expect(
      computePriorityScore({ role: baseRole({ title: 'Anything' }) as never, company: null, weights, preferences: NO_PREFERENCES }),
    ).toBeCloseTo(0.5, 5);
    expect(
      computePriorityScore({
        role: baseRole({ title: null }) as never,
        company: null,
        weights,
        preferences: { ...NO_PREFERENCES, titleKeywords: ['backend'] },
      }),
    ).toBeCloseTo(0.5, 5);
  });
});

describe('computePriorityScore — company_preference', () => {
  const weights = { ...EQUAL_WEIGHTS, comp_fit: 0, remote_eu_match: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 1 };

  it('maps -2..2 onto 0..1 linearly', () => {
    const cases: [number, number][] = [
      [-2, 0],
      [-1, 0.25],
      [0, 0.5],
      [1, 0.75],
      [2, 1],
    ];
    for (const [rating, expected] of cases) {
      const score = computePriorityScore({
        role: baseRole() as never,
        company: baseCompany({ preference_rating: rating }) as never,
        weights,
        preferences: NO_PREFERENCES,
      });
      expect(score).toBeCloseTo(expected, 5);
    }
  });

  it('is neutral (0.5) when there is no company yet', () => {
    const score = computePriorityScore({ role: baseRole() as never, company: null, weights, preferences: NO_PREFERENCES });
    expect(score).toBeCloseTo(0.5, 5);
  });
});

describe('weights scale the contribution of each term', () => {
  it('a zero weight excludes a term entirely regardless of its value', () => {
    const score = computePriorityScore({
      role: baseRole({ remote_eu: 'yes' }) as never,
      company: null,
      weights: { ...EQUAL_WEIGHTS, remote_eu_match: 0, comp_fit: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 },
      preferences: NO_PREFERENCES,
    });
    expect(score).toBeCloseTo(0, 5);
  });

  it('is a weighted sum, not an average — higher weights scale contribution up directly', () => {
    const score = computePriorityScore({
      role: baseRole({ remote_eu: 'yes' }) as never,
      company: null,
      weights: { ...EQUAL_WEIGHTS, remote_eu_match: 5, comp_fit: 0, ai_proof: 0, wlb: 0, preference_match: 0, company_preference: 0 },
      preferences: NO_PREFERENCES,
    });
    expect(score).toBeCloseTo(5, 5);
  });
});

describe('recomputePriorityForRole / recomputePriorityForCompanyRoles (DB integration)', () => {
  let tempDir: string;
  let db: Database.Database;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-priority-'));
    db = openDb(path.join(tempDir, 'career-mate.db'));
    originalDataDir = process.env.CM_DATA_DIR;
    process.env.CM_DATA_DIR = tempDir; // so loadScoringWeights/loadPreferences seed defaults into this temp dir, not the real project
  });

  afterEach(() => {
    process.env.CM_DATA_DIR = originalDataDir;
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists a computed score onto the role row', () => {
    const role = createRole(db, { url: 'https://example.com/jobs/1' });
    expect(getRoleById(db, role.id)?.priority_score).toBeNull();

    recomputePriorityForRole(db, role.id);

    const updated = getRoleById(db, role.id);
    expect(updated?.priority_score).not.toBeNull();
    expect(typeof updated?.priority_score).toBe('number');
  });

  it('recomputes every role at a company when company-level data changes', () => {
    const company = createCompany(db, 'https://acme.example.com', 'Acme');
    const roleA = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/a' });
    const roleB = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/b' });
    recomputePriorityForRole(db, roleA.id);
    recomputePriorityForRole(db, roleB.id);
    const beforeA = getRoleById(db, roleA.id)!.priority_score!;
    const beforeB = getRoleById(db, roleB.id)!.priority_score!;

    setPreferenceRating(db, company.id, 2);
    recomputePriorityForCompanyRoles(db, company.id);

    const afterA = getRoleById(db, roleA.id)!.priority_score!;
    const afterB = getRoleById(db, roleB.id)!.priority_score!;
    expect(afterA).toBeGreaterThan(beforeA);
    expect(afterB).toBeGreaterThan(beforeB);
    expect(getCompanyById(db, company.id)?.preference_rating).toBe(2);
  });
});
