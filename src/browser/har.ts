/**
 * Strips credentials out of a recorded HAR.
 *
 * The entire purpose of career-mate's browser profile is an *authenticated*
 * session, so a HAR recorded through it carries the live session cookie in
 * plaintext — in the request `Cookie` header, the response `Set-Cookie`, and
 * the HAR's own `cookies` arrays. `cm auth record-har` exists to produce a
 * file you keep and replay later, and `--out` writes wherever you point it,
 * so without this the command's happy path is "save a credential-equivalent
 * file next to your source tree".
 *
 * Redaction rather than a warning, because it costs the feature nothing:
 * `routeFromHAR` matches on URL and method and serves the recorded body. It
 * never reads these headers back, so a redacted HAR replays identically to
 * the one that came off the wire.
 *
 * What this does *not* claim: response **bodies** are recorded whole
 * (`content: 'embed'`), so a page or API response that prints a token in its
 * own body still contains it. This removes the credential the profile
 * itself supplies; it is not a general-purpose scrubber, and the CLI says so.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../lib/paths.js';

export const REDACTED = '[redacted by career-mate]';

/**
 * Headers that carry a credential rather than describing the request.
 *
 * Matched case-insensitively: HTTP header names are case-insensitive and
 * Chromium writes them lowercased while other tools do not, so an
 * exact-match list would silently miss half of them.
 */
const SECRET_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
]);

interface NameValue {
  name?: unknown;
  value?: unknown;
}

function redactHeaders(headers: unknown): number {
  if (!Array.isArray(headers)) return 0;
  let count = 0;
  for (const header of headers as NameValue[]) {
    if (typeof header?.name !== 'string') continue;
    if (!SECRET_HEADERS.has(header.name.toLowerCase())) continue;
    header.value = REDACTED;
    count += 1;
  }
  return count;
}

/** Every cookie is a credential here; the names are kept so the shape still reads as a HAR. */
function redactCookies(cookies: unknown): number {
  if (!Array.isArray(cookies)) return 0;
  let count = 0;
  for (const cookie of cookies as NameValue[]) {
    if (typeof cookie?.value !== 'string') continue;
    cookie.value = REDACTED;
    count += 1;
  }
  return count;
}

/**
 * Rewrites the HAR in place, returning how many values were replaced.
 *
 * Best effort by construction: this runs after the fetch has already
 * happened, so a malformed or missing file returns 0 rather than failing the
 * command that produced it. The caller reports the count, which is what
 * makes a silent no-op visible instead of looking like success.
 */
export function redactHarSecrets(file: string): number {
  let har: { log?: { entries?: unknown } };
  try {
    har = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return 0;
  }

  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) return 0;

  let count = 0;
  for (const entry of entries as { request?: NameValue; response?: NameValue }[]) {
    for (const half of [entry?.request, entry?.response]) {
      if (!half || typeof half !== 'object') continue;
      count += redactHeaders((half as { headers?: unknown }).headers);
      count += redactCookies((half as { cookies?: unknown }).cookies);
    }
  }

  if (count > 0) {
    try {
      fs.writeFileSync(file, JSON.stringify(har));
    } catch {
      return 0;
    }
  }
  return count;
}

/**
 * Where a recording goes when `--out` is not given.
 *
 * Keyed on the host *and the path*, not the host alone: two pages on one
 * site is the normal case — a listing and a detail page — and a host-only
 * name made the second recording silently replace the first, which is the
 * same overwrite `allocateTracePath` goes to trouble to avoid for traces.
 */
export function defaultHarPath(url: string): string {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return path.join(getDataDir(), 'har', `${slug.slice(0, 80) || 'recording'}.har`);
}
