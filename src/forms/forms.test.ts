import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchApplicationForm, summarizeForm } from './index.js';

/**
 * Both fixtures are *captured responses*, not hand-written ones: an invented
 * payload tests the parser against my idea of the API, which is exactly
 * what the Backlog entry for this feature got wrong (it named an operation
 * that does not exist and a shape that is not the one served).
 */
function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), 'utf-8'));
}

/** A `fetch` stand-in that answers with a fixed payload and records what it was asked for. */
function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const impl = (async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(input), body: typeof options?.body === 'string' ? options.body : undefined });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ASHBY_URL = 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245';
const GREENHOUSE_URL = 'https://boards.greenhouse.io/figma/jobs/5426468004';

describe('fetchApplicationForm — Ashby', () => {
  it('reads the real captured response', async () => {
    const { impl, calls } = stubFetch(fixture('ashby-form.json'));

    const form = await fetchApplicationForm(ASHBY_URL, impl);

    expect(form?.provider).toBe('ashby');
    expect(form?.title).toBe('Security Engineer, Cloud');
    expect(form?.compensationSummary).toBe('$211.4K – $290.6K • Offers Equity');
    expect(form?.fields.length).toBe(13);

    // The board and posting id go out as *variables*, from the tracked URL —
    // never a slug guessed from a company name, which would return another
    // company's form and look entirely correct.
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.variables).toEqual({
      organizationHostedJobsPageName: 'ramp',
      jobPostingId: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
    });
  });

  it('answers the question the command exists for', async () => {
    const { impl } = stubFetch(fixture('ashby-form.json'));
    const form = (await fetchApplicationForm(ASHBY_URL, impl))!;

    // Three required essays is a different evening from a resume drop.
    expect(summarizeForm(form)).toEqual({ total: 13, required: 11, essays: 3, files: 1 });
  });

  it('maps the types that change what an evening looks like', async () => {
    const { impl } = stubFetch(fixture('ashby-form.json'));
    const form = (await fetchApplicationForm(ASHBY_URL, impl))!;

    const byTitle = (needle: string) => form.fields.find((field) => field.title.includes(needle));
    expect(byTitle('Resume')?.type).toBe('file');
    expect(byTitle('Legal Name')?.type).toBe('text');
    expect(byTitle('Where do you plan on working')?.type).toBe('location');
    expect(byTitle('Please elaborate')?.type).toBe('long-text');
    expect(byTitle('minimum of 7 years')?.type).toBe('boolean');
  });

  it('treats a GraphQL error as a failure, not as an empty form', async () => {
    // The endpoint answers 200 with an `errors` array, so checking the
    // status alone would read a schema change as "this job asks nothing".
    const { impl } = stubFetch({ errors: [{ message: 'Cannot query field "applicationForm"' }] });
    await expect(fetchApplicationForm(ASHBY_URL, impl)).rejects.toThrow(/Cannot query field/);
  });

  it('reports a form whose questions it cannot read, rather than showing none', async () => {
    // "0 questions" reads as good news; a shape change must not look like
    // one.
    const { impl } = stubFetch({ data: { jobPosting: { title: 'X', applicationForm: { sections: [] } } } });
    await expect(fetchApplicationForm(ASHBY_URL, impl)).rejects.toThrow(/shape has probably changed/);
  });

  it.each([
    ['absent', { data: { jobPosting: { title: 'X' } } }],
    ['null', { data: { jobPosting: { title: 'X', applicationForm: null } } }],
    ['renamed', { data: { jobPosting: { title: 'X', applicantForm: { sections: [] } } } }],
  ])('refuses a posting whose applicationForm is %s', async (_label, payload) => {
    // The likeliest drift, and the one the first guard missed: it only fired
    // when `applicationForm` was a record, so an absent or renamed key
    // produced a confident "0 question(s), 0 required".
    const { impl } = stubFetch(payload);
    await expect(fetchApplicationForm(ASHBY_URL, impl)).rejects.toThrow(/no application form/);
  });

  it('reports a non-JSON body instead of a bare SyntaxError', async () => {
    // What a Cloudflare challenge or an error page actually returns: HTTP
    // 200 with HTML.
    const impl = (async () =>
      ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchApplicationForm(ASHBY_URL, impl)).rejects.toThrow(/not JSON/);
  });

  it('skips hidden entries, which the applicant never sees', async () => {
    const payload = {
      data: {
        jobPosting: {
          title: 'X',
          applicationForm: {
            sections: [
              {
                fieldEntries: [
                  { id: '1', isRequired: true, field: { title: 'Name', type: 'String' } },
                  { id: '2', isRequired: true, isHidden: true, field: { title: 'Secret source', type: 'String' } },
                ],
              },
            ],
          },
        },
      },
    };
    const { impl } = stubFetch(payload);
    const form = (await fetchApplicationForm(ASHBY_URL, impl))!;
    expect(form.fields.map((f) => f.title)).toEqual(['Name']);
  });

  it('reads help text out of HTML', async () => {
    const payload = {
      data: {
        jobPosting: {
          title: 'X',
          applicationForm: {
            sections: [
              {
                fieldEntries: [
                  {
                    id: '1',
                    isRequired: false,
                    field: { title: 'Links', type: 'String' },
                    descriptionHtml: '<p>GitHub &amp; portfolio,&nbsp;please</p>',
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const { impl } = stubFetch(payload);
    const form = (await fetchApplicationForm(ASHBY_URL, impl))!;
    expect(form.fields[0]!.description).toBe('GitHub & portfolio, please');
  });
});

describe('fetchApplicationForm — Greenhouse', () => {
  it('reads the real captured response from the public, versioned API', async () => {
    const { impl, calls } = stubFetch(fixture('greenhouse-form.json'));

    const form = await fetchApplicationForm(GREENHOUSE_URL, impl);

    expect(form?.provider).toBe('greenhouse');
    expect(form?.title).toBe('Account Executive, Enterprise');
    expect(calls[0]!.url).toBe('https://boards-api.greenhouse.io/v1/boards/figma/jobs/5426468004?questions=true');
    // The full count object, not just `essays`: asserting one number lets a
    // regression that dropped 13 of 14 questions pass.
    expect(summarizeForm(form!)).toEqual({ total: 14, required: 9, essays: 1, files: 1 });
  });

  it('maps Greenhouse input types onto the same coarse kinds', async () => {
    const { impl } = stubFetch(fixture('greenhouse-form.json'));
    const form = (await fetchApplicationForm(GREENHOUSE_URL, impl))!;

    const byTitle = (needle: string) => form.fields.find((field) => field.title.includes(needle));
    expect(byTitle('Resume')?.type).toBe('file');
    expect(byTitle('First Name')?.type).toBe('text');
    expect(byTitle('Why do you want to join')?.type).toBe('long-text');
    expect(byTitle('Pronouns')?.type).toBe('choice');
  });

  it('does not invent pay or a deadline it was never given', async () => {
    // The board API publishes neither. Printing an empty value would read
    // as "none stated" rather than "not available here".
    const { impl } = stubFetch(fixture('greenhouse-form.json'));
    const form = (await fetchApplicationForm(GREENHOUSE_URL, impl))!;
    expect(form.compensationSummary).toBeNull();
    expect(form.deadline).toBeNull();
  });

  it('turns HTML help text into something readable', async () => {
    // Greenhouse returns `description` as HTML — the captured fixture is
    // full of `<p>` tags, which were printed literally at the user.
    const { impl } = stubFetch(fixture('greenhouse-form.json'));
    const form = (await fetchApplicationForm(GREENHOUSE_URL, impl))!;
    const described = form.fields.filter((field) => field.description);
    expect(described.length).toBeGreaterThan(0);
    for (const field of described) expect(field.description).not.toMatch(/<[a-z]/i);
  });

  it('refuses a response with no questions key at all', async () => {
    // The API omits it unless `?questions=true` survives the request, so a
    // stripped parameter or a redirect would read as "this job asks
    // nothing".
    const { impl } = stubFetch({ id: 1, title: 'Y' });
    await expect(fetchApplicationForm(GREENHOUSE_URL, impl)).rejects.toThrow(/no questions/);
  });

  it('surfaces an HTTP failure with its status', async () => {
    const { impl } = stubFetch({}, { ok: false, status: 404 });
    await expect(fetchApplicationForm(GREENHOUSE_URL, impl)).rejects.toThrow(/HTTP 404/);
  });
});

describe('field text that is not a question', () => {
  it('carries an absurdly long title through intact, for the caller to bound', () => {
    // A live Ramp posting embeds a 2 KB base64 blob as a field title. The
    // parser must not silently lose it — where to cut it is a display
    // decision, made once at the point of printing.
    const long = 'x'.repeat(2000);
    const payload = {
      data: {
        jobPosting: {
          title: 'X',
          applicationForm: { sections: [{ fieldEntries: [{ id: '1', isRequired: true, field: { title: long, type: 'LongText' } }] }] },
        },
      },
    };
    const { impl } = stubFetch(payload);
    return fetchApplicationForm(ASHBY_URL, impl).then((form) => {
      expect(form!.fields[0]!.title.length).toBe(2000);
    });
  });
});

describe('fetchApplicationForm — boards with no form API', () => {
  it('returns undefined without making a request', async () => {
    const { impl, calls } = stubFetch({});
    expect(await fetchApplicationForm('https://jobs.lever.co/netlify/abc', impl)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
