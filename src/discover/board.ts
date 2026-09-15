/**
 * Which job board a company publishes on, and how to read its whole
 * posting list for free.
 *
 * `cm discover` pays one sonnet-with-web-search call per tracked company.
 * Both major boards publish the complete list over plain HTTP — measured on
 * 2026-09-15: ramp 145 postings, stripe 631, figma 159, linear 30 — and
 * that list is the publisher's own, so unlike a web search it cannot miss a
 * posting or invent one.
 *
 * **The board is never guessed from a company name.** A slug derived that
 * way is a coin flip, and a wrong one silently returns *another company's*
 * postings — every one of which would be tracked and then paid for through
 * a full enrichment chain. It is read from a role URL already tracked for
 * that company instead.
 *
 * That is strong evidence, not proof, and the difference matters. The
 * URL→board half is exact; the company→URL half is not, because
 * `resolveRoleCompany` attaches roles to companies from model-extracted
 * page content. One posting mis-attributed to a company — a recruiting
 * agency's board, a parent org's, a name collision — would make this read
 * the wrong board and import its whole list. Two things bound that: the
 * per-run creation cap in `applyDiscoveredRoles`, and the requirement that
 * a title filter be configured at all, so a wrong board yields a handful of
 * wrong-looking titles rather than six hundred.
 */

import { FetchError } from '../pages/fetch.js';
import { formTargetFor, type FormProvider } from '../forms/provider.js';
import { withTimeout } from '../forms/timeout.js';

export interface CompanyBoard {
  provider: FormProvider;
  board: string;
}

export interface BoardPosting {
  title: string;
  url: string;
}

/**
 * The board a company's tracked role URLs prove it uses.
 *
 * `urls` is expected newest-first: when a company has moved between ATSes
 * the most recent posting is the one that says where new postings will
 * appear, and old URLs on the previous board would otherwise pin discovery
 * to a list that no longer grows.
 */
export function boardFromRoleUrls(urls: string[]): CompanyBoard | undefined {
  for (const url of urls) {
    const target = formTargetFor(url);
    if (target) return { provider: target.provider, board: target.board };
  }
  return undefined;
}

function listUrl(board: CompanyBoard): string {
  const slug = encodeURIComponent(board.board);
  return board.provider === 'ashby'
    ? `https://api.ashbyhq.com/posting-api/job-board/${slug}`
    : `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The URL to track a posting at.
 *
 * Ashby's `jobUrl` is canonical and per-posting, so it is used as given.
 *
 * Greenhouse's `absolute_url` is **not safe to use directly**: for a board
 * embedded in the company's own site it is the site's careers page with the
 * posting in the query string (`https://acme.com/careers?gh_jid=123`), and
 * `normalizeUrl` — which decides whether a role is already tracked — keeps
 * only host and path. Every posting on such a board therefore normalizes to
 * the same string, so the first one is created and all 200 others are
 * counted as duplicates, silently. The canonical board URL is built from
 * the id instead: unique per posting, and a URL `formTargetFor` can read
 * back.
 */
function postingUrl(board: CompanyBoard, job: Record<string, unknown>): string {
  if (board.provider === 'ashby') {
    return typeof job.jobUrl === 'string' ? job.jobUrl.trim() : '';
  }
  const id = typeof job.id === 'number' || typeof job.id === 'string' ? String(job.id).trim() : '';
  if (!/^\d+$/.test(id)) return '';
  return `https://boards.greenhouse.io/${encodeURIComponent(board.board)}/jobs/${id}`;
}

/**
 * Every posting the board currently publishes.
 *
 * An unreadable response is an error, never an empty list: "this company
 * has no openings" is a conclusion `applyDiscoveredRoles` would act on, and
 * a caller that fell back to the paid search on an error would at least
 * still find them.
 */
export async function fetchBoardPostings(
  board: CompanyBoard,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardPosting[]> {
  const url = listUrl(board);
  const body = await withTimeout(`${board.provider} board listing`, async (signal) => {
    const response = await fetchImpl(url, {
      signal,
      headers: { 'user-agent': 'career-mate/0.1 (personal job-search tracker)' },
    });
    if (!response.ok) {
      throw new FetchError(`${board.provider} board listing failed: HTTP ${response.status}`, response.status);
    }
    return (await response.json().catch(() => {
      throw new FetchError(`${board.provider} board listing returned a body that is not JSON`);
    })) as unknown;
  });

  const jobs = isRecord(body) && Array.isArray(body.jobs) ? body.jobs : undefined;
  if (!jobs) throw new FetchError(`${board.provider} board listing had no jobs array — the API shape has changed`);

  const postings: BoardPosting[] = [];
  for (const job of jobs) {
    if (!isRecord(job)) continue;
    // Ashby marks postings that exist but are not publicly listed. Tracking
    // one would create a role from a page the applicant cannot reach.
    if (job.isListed === false) continue;
    const title = typeof job.title === 'string' ? job.title.trim() : '';
    const url = postingUrl(board, job);
    if (!title || !url) continue;
    postings.push({ title, url });
  }

  // A per-item shape change is as silent as a top-level one, and worse in
  // effect: if `jobUrl`/`absolute_url` is renamed, every entry is dropped,
  // the caller sees an empty board, and `cm discover` becomes a permanent
  // no-op for that company with nothing in the logs. A board that lists
  // jobs must yield postings.
  if (jobs.length > 0 && postings.length === 0) {
    throw new FetchError(
      `${board.provider} board listing had ${jobs.length} job(s) but none could be read — the API shape has changed`,
    );
  }

  return postings;
}
