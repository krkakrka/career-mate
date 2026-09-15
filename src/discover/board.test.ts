import { describe, expect, it } from 'vitest';
import { boardFromRoleUrls, fetchBoardPostings } from './board.js';

function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('boardFromRoleUrls', () => {
  it('proves the board from a role URL already tracked', () => {
    // Never guessed from a company name: a wrong slug silently returns
    // another company's postings, and every one would be tracked and then
    // paid for through a full enrichment chain.
    expect(boardFromRoleUrls(['https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245'])).toEqual({
      provider: 'ashby',
      board: 'ramp',
    });
    expect(boardFromRoleUrls(['https://boards.greenhouse.io/figma/jobs/5426468004'])).toEqual({
      provider: 'greenhouse',
      board: 'figma',
    });
  });

  it('prefers the newest board when a company has moved between ATSes', () => {
    // Callers pass newest-first. Pinning discovery to the old board would
    // keep reading a list that no longer grows.
    expect(
      boardFromRoleUrls([
        'https://boards.greenhouse.io/newco/jobs/123',
        'https://jobs.ashbyhq.com/oldco/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      ]),
    ).toEqual({ provider: 'greenhouse', board: 'newco' });
  });

  it('skips URLs that prove nothing', () => {
    expect(
      boardFromRoleUrls([
        'https://acme.example.com/careers/engineer',
        'https://jobs.lever.co/netlify/abc',
        'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      ]),
    ).toEqual({ provider: 'ashby', board: 'ramp' });
  });

  it('says nothing when no tracked URL identifies a board', () => {
    expect(boardFromRoleUrls([])).toBeUndefined();
    expect(boardFromRoleUrls(['https://acme.example.com/careers/1'])).toBeUndefined();
  });
});

describe('fetchBoardPostings', () => {
  const ASHBY = { provider: 'ashby' as const, board: 'ramp' };
  const GREENHOUSE = { provider: 'greenhouse' as const, board: 'figma' };

  it('reads the Ashby list shape and its canonical URLs', () => {
    const { impl, calls } = stubFetch({
      jobs: [
        { title: ' Security Engineer ', jobUrl: 'https://jobs.ashbyhq.com/ramp/abc', isListed: true },
        { title: 'Designer', jobUrl: 'https://jobs.ashbyhq.com/ramp/def', isListed: true },
      ],
    });

    return fetchBoardPostings(ASHBY, impl).then((postings) => {
      expect(calls[0]).toBe('https://api.ashbyhq.com/posting-api/job-board/ramp');
      expect(postings).toEqual([
        { title: 'Security Engineer', url: 'https://jobs.ashbyhq.com/ramp/abc' },
        { title: 'Designer', url: 'https://jobs.ashbyhq.com/ramp/def' },
      ]);
    });
  });

  it('honours isListed, which marks a posting the applicant cannot reach', async () => {
    const { impl } = stubFetch({
      jobs: [
        { title: 'Public', jobUrl: 'https://jobs.ashbyhq.com/ramp/a', isListed: true },
        { title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/ramp/b', isListed: false },
      ],
    });
    expect((await fetchBoardPostings(ASHBY, impl)).map((p) => p.title)).toEqual(['Public']);
  });

  it('reads the Greenhouse list shape and builds a canonical per-posting URL', async () => {
    const { impl, calls } = stubFetch({
      jobs: [{ id: 5426468004, title: 'Account Executive', absolute_url: 'https://boards.greenhouse.io/figma/jobs/5426468004?gh_jid=5426468004' }],
    });
    const postings = await fetchBoardPostings(GREENHOUSE, impl);
    expect(calls[0]).toBe('https://boards-api.greenhouse.io/v1/boards/figma/jobs');
    expect(postings[0]!.url).toBe('https://boards.greenhouse.io/figma/jobs/5426468004');
  });

  it('does not collapse a site-embedded board into a single role', async () => {
    // For a board embedded in the company's own site, `absolute_url` is the
    // careers page with the posting in the query string — and `normalizeUrl`
    // keeps only host and path, so every posting on such a board would
    // normalize to the same string. The first would be created and the
    // other 200 silently counted as duplicates.
    const { impl } = stubFetch({
      jobs: [
        { id: 1, title: 'One', absolute_url: 'https://acme.com/careers?gh_jid=1' },
        { id: 2, title: 'Two', absolute_url: 'https://acme.com/careers?gh_jid=2' },
        { id: 3, title: 'Three', absolute_url: 'https://acme.com/careers?gh_jid=3' },
      ],
    });
    const urls = (await fetchBoardPostings(GREENHOUSE, impl)).map((p) => p.url);
    expect(new Set(urls).size).toBe(3);
    expect(urls).toEqual([
      'https://boards.greenhouse.io/figma/jobs/1',
      'https://boards.greenhouse.io/figma/jobs/2',
      'https://boards.greenhouse.io/figma/jobs/3',
    ]);
  });

  it('skips entries with no title or no URL rather than creating half a role', async () => {
    const { impl } = stubFetch({
      jobs: [{ title: '', jobUrl: 'https://x/1' }, { title: 'No URL' }, { title: 'Good', jobUrl: 'https://x/2' }],
    });
    expect((await fetchBoardPostings(ASHBY, impl)).map((p) => p.title)).toEqual(['Good']);
  });

  it('treats an unreadable response as an error, never as "no openings"', async () => {
    // "This company has no openings" is a conclusion the caller acts on; a
    // shape change must not be able to produce it.
    await expect(fetchBoardPostings(ASHBY, stubFetch({ postings: [] }).impl)).rejects.toThrow(/shape has changed/);
    await expect(fetchBoardPostings(ASHBY, stubFetch({}, { ok: false, status: 404 }).impl)).rejects.toThrow(/HTTP 404/);
  });

  it('treats a listing whose items it cannot read as an error', async () => {
    // Worse than a top-level shape change, because it is invisible: if
    // `jobUrl` is renamed, every entry is dropped, the caller sees an empty
    // board, and discovery becomes a permanent no-op for that company with
    // nothing in the logs.
    const { impl } = stubFetch({ jobs: [{ title: 'Staff Engineer', postingUrl: 'https://x/1' }] });
    await expect(fetchBoardPostings(ASHBY, impl)).rejects.toThrow(/none could be read/);
  });

  it('accepts a genuinely empty board', async () => {
    // Distinct from the case above: `jobs: []` is the board saying it has
    // nothing, which is a real answer.
    expect(await fetchBoardPostings(ASHBY, stubFetch({ jobs: [] }).impl)).toEqual([]);
  });
});
