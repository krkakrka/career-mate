import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseDate } from './parsers.js';

describe('parseDate', () => {
  it('accepts a real calendar date and returns UTC-midnight ISO', () => {
    expect(parseDate('2027-01-15')).toBe('2027-01-15T00:00:00.000Z');
  });

  it('accepts Feb 29 on a leap year', () => {
    expect(parseDate('2028-02-29')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rejects a malformed format', () => {
    expect(() => parseDate('15-01-2027')).toThrow(InvalidArgumentError);
    expect(() => parseDate('2027/01/15')).toThrow(InvalidArgumentError);
  });

  it('rejects a day that overflows its month instead of silently rolling over', () => {
    // JS Date would otherwise normalize this to 2026-03-02 with no error.
    expect(() => parseDate('2026-02-30')).toThrow(InvalidArgumentError);
  });

  it('rejects Feb 29 on a non-leap year', () => {
    expect(() => parseDate('2027-02-29')).toThrow(InvalidArgumentError);
  });

  it('rejects a month out of range', () => {
    expect(() => parseDate('2027-13-01')).toThrow(InvalidArgumentError);
  });
});
