import { InvalidArgumentError } from 'commander';
import { ROLE_STATUSES, type RoleStatus } from '../domain/role-status.js';

export function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseRating(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -2 || parsed > 2) {
    throw new InvalidArgumentError(`Expected an integer between -2 and 2, got "${value}"`);
  }
  return parsed;
}

export function parseHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError(`Expected a valid URL, got "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidArgumentError(`Expected an http(s) URL, got "${value}"`);
  }
  return value;
}

export function parseRoleStatus(value: string): RoleStatus {
  if (!(ROLE_STATUSES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of ${ROLE_STATUSES.join(', ')}, got "${value}"`);
  }
  return value as RoleStatus;
}

const SORT_FIELDS = ['priority', 'updated', 'company'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export function parseSortField(value: string): SortField {
  if (!(SORT_FIELDS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Expected one of ${SORT_FIELDS.join(', ')}, got "${value}"`);
  }
  return value as SortField;
}

/** Accepts YYYY-MM-DD and returns a full ISO timestamp at UTC midnight, matching how reapply_after is stored elsewhere. */
export function parseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new InvalidArgumentError(`Expected a date in YYYY-MM-DD format, got "${value}"`);
  }

  const [, yearStr, monthStr, dayStr] = match as unknown as [string, string, string, string];
  const date = new Date(`${value}T00:00:00.000Z`);
  // JS Date silently rolls day overflow into the next month (e.g. Feb 30 ->
  // Mar 2) instead of producing NaN, so round-trip the parsed components
  // against what was requested rather than trusting getTime() alone.
  const roundTrips =
    date.getUTCFullYear() === Number(yearStr) &&
    date.getUTCMonth() === Number(monthStr) - 1 &&
    date.getUTCDate() === Number(dayStr);
  if (Number.isNaN(date.getTime()) || !roundTrips) {
    throw new InvalidArgumentError(`"${value}" is not a valid date`);
  }
  return date.toISOString();
}
