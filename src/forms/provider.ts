/**
 * Which application-form API, if any, serves a given posting URL.
 *
 * Kept pure and separate from fetching because this is where the risk is:
 * pointing a form request at the wrong board slug returns *another
 * company's* form, which would be confidently wrong rather than an error.
 * Every identifier here comes out of the URL the user is already tracking —
 * nothing is guessed from a company name.
 */

export type FormProvider = 'ashby' | 'greenhouse';

export interface AshbyTarget {
  provider: 'ashby';
  /** The job board name in the URL path, e.g. `ramp`. */
  board: string;
  /** The posting's UUID. */
  postingId: string;
}

export interface GreenhouseTarget {
  provider: 'greenhouse';
  board: string;
  postingId: string;
}

export type FormTarget = AshbyTarget | GreenhouseTarget;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Ashby posting ids are UUIDs; anything else in that position is a department or filter page, not a posting. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Greenhouse hosts served by `boards-api.greenhouse.io`. Regional hosts are deliberately absent until their API host is verified. */
const US_GREENHOUSE_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io', 'greenhouse.io']);

/**
 * Reads a posting URL into the board and posting id its API needs.
 *
 * Returns `undefined` rather than throwing for anything unrecognised: most
 * postings are on boards with no form API at all (Lever publishes postings
 * but not their questions; a company's own careers page publishes neither),
 * and "this board does not expose its form" is an ordinary answer, not a
 * failure.
 */
export function formTargetFor(url: string): FormTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  // `filter(Boolean)` so a trailing slash or a doubled separator does not
  // shift every segment along and turn a valid URL into a wrong lookup.
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (hostMatches(host, 'ashbyhq.com')) {
    // jobs.ashbyhq.com/<board>/<uuid>[/application]
    const [board, postingId] = segments;
    if (!board || !postingId || !UUID.test(postingId)) return undefined;
    return { provider: 'ashby', board, postingId };
  }

  if (hostMatches(host, 'greenhouse.io')) {
    // Only the hosts whose API region is known. Board tokens are namespaced
    // per region, so looking an EU posting up on the US API is a 404 at
    // best and *another company's board with the same slug* at worst —
    // exactly the confidently-wrong outcome this module exists to prevent.
    // Supporting `*.eu.greenhouse.io` means verifying its API host, not
    // assuming one.
    if (!US_GREENHOUSE_HOSTS.has(host)) return undefined;
    // boards.greenhouse.io/<board>/jobs/<id>, and the embed variant
    // job-boards.greenhouse.io/<board>/jobs/<id>.
    const jobsAt = segments.indexOf('jobs');
    if (jobsAt < 1) return undefined;
    const board = segments[jobsAt - 1];
    const postingId = segments[jobsAt + 1];
    // Greenhouse ids are numeric. A `gh_jid` query parameter is the
    // canonical id when the path one is absent.
    const fromQuery = parsed.searchParams.get('gh_jid');
    const id = postingId && /^\d+$/.test(postingId) ? postingId : fromQuery;
    if (!board || !id || !/^\d+$/.test(id)) return undefined;
    return { provider: 'greenhouse', board, postingId: id };
  }

  return undefined;
}
