import { describe, expect, it } from 'vitest';
import type { Preferences } from '../config/preferences.js';
import { matchesPreferences } from './preference-match.js';

const NO_KEYWORDS: Preferences = {
  titleKeywords: [],
  seniority: null,
  remoteEuRequired: false,
  minSalary: null,
};

const BACKEND_KEYWORDS: Preferences = {
  ...NO_KEYWORDS,
  titleKeywords: ['backend', 'platform'],
};

describe('matchesPreferences', () => {
  it('matches everything when no keywords are configured', () => {
    expect(matchesPreferences('Sales Development Representative', NO_KEYWORDS)).toBe(true);
    expect(matchesPreferences(null, NO_KEYWORDS)).toBe(true);
  });

  it('matches a title containing any configured keyword, case-insensitively', () => {
    expect(matchesPreferences('Senior Backend Engineer', BACKEND_KEYWORDS)).toBe(true);
    expect(matchesPreferences('PLATFORM Engineer', BACKEND_KEYWORDS)).toBe(true);
  });

  it('rejects a title matching none of the configured keywords', () => {
    expect(matchesPreferences('Product Designer', BACKEND_KEYWORDS)).toBe(false);
  });

  it('rejects a null title when keywords are configured (nothing to match against)', () => {
    expect(matchesPreferences(null, BACKEND_KEYWORDS)).toBe(false);
  });
});
