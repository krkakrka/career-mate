import { InvalidArgumentError } from 'commander';

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
