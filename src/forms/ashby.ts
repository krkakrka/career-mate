/**
 * Ashby's application form, read from the same endpoint its own job page
 * calls.
 *
 * **Unversioned and internal**, so it gets the treatment Step 25 gave
 * protocol drift: a hand-written minimal query rather than a replay of
 * theirs, every field read defensively, and a clear error when the shape
 * stops matching instead of a confident empty form.
 *
 * Measured on 2026-09-14 against live postings, because the Backlog entry
 * was wrong on both counts. It named the operation
 * `ApplicationFormFromJobPosting`; that field does not exist and the
 * endpoint says so outright. The real operation is `ApiJobPosting`, and the
 * shape is `jobPosting.applicationForm.sections[].fieldEntries[]` rather than
 * the `formDefinition.fields[]` the entry described.
 *
 * The query is ~330 bytes instead of the 2 KB the page sends, which is
 * possible only because `field` is a JSON scalar: no fragment has to name
 * its subfields, so there is far less of their schema to drift against.
 */

import { FetchError } from '../pages/fetch.js';
import { plainText } from './html-text.js';
import { withTimeout } from './timeout.js';
import type { ApplicationForm, FormField, FormFieldType } from './types.js';
import type { AshbyTarget } from './provider.js';

const ENDPOINT = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting';

const QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title applicationDeadline compensationTierSummary
    applicationForm { sections { title fieldEntries { id isRequired field descriptionHtml isHidden } } }
  }
}`;

/** Ashby's own type names, mapped to the coarse kinds worth distinguishing. */
function toFieldType(raw: unknown): FormFieldType {
  switch (String(raw)) {
    case 'LongText':
      return 'long-text';
    case 'File':
      return 'file';
    case 'Boolean':
      return 'boolean';
    case 'ValueSelect':
    case 'MultiValueSelect':
      return 'choice';
    case 'Location':
      return 'location';
    case 'String':
    case 'Email':
    case 'Phone':
    case 'Number':
    case 'SocialLink':
      return 'text';
    default:
      return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function fetchAshbyForm(target: AshbyTarget, fetchImpl: typeof fetch = fetch): Promise<ApplicationForm> {
  const body = await withTimeout('Ashby', async (signal) => {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'user-agent': 'career-mate/0.1 (personal job-search tracker)' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: { organizationHostedJobsPageName: target.board, jobPostingId: target.postingId },
        query: QUERY,
      }),
    });

    if (!response.ok) throw new FetchError(`Ashby form request failed: HTTP ${response.status}`, response.status);
    // A Cloudflare challenge or an error page answers 200 with HTML, and
    // `json()` then throws a SyntaxError that says nothing useful.
    return (await response.json().catch(() => {
      throw new FetchError('Ashby returned a body that is not JSON');
    })) as { data?: { jobPosting?: unknown }; errors?: { message?: string }[] };
  });
  // GraphQL answers 200 with an `errors` array, so a non-ok check alone
  // would read a schema change as an empty form.
  if (body.errors?.length) {
    throw new FetchError(`Ashby rejected the form query: ${body.errors[0]?.message ?? 'unknown error'}`);
  }

  const posting = body.data?.jobPosting;
  if (!isRecord(posting)) throw new FetchError(`Ashby returned no posting for ${target.board}/${target.postingId}`);

  // Checked before reading it, not after. The guard used to be
  // `if (form && fields.length === 0)`, which only fired when
  // `applicationForm` was a record — so the *likeliest* drift, the key being
  // renamed or absent, sailed through and produced a confident
  // "0 question(s), 0 required". An empty form reads as good news, so it has
  // to be impossible to reach by accident.
  if (!isRecord(posting.applicationForm)) {
    throw new FetchError(
      `Ashby returned no application form for ${target.board}/${target.postingId} — the posting may be closed, or the API shape has changed`,
    );
  }
  const form = posting.applicationForm;
  const sections = Array.isArray(form.sections) ? form.sections : [];

  const fields: FormField[] = [];
  for (const section of sections) {
    if (!isRecord(section) || !Array.isArray(section.fieldEntries)) continue;
    for (const entry of section.fieldEntries) {
      if (!isRecord(entry)) continue;
      // A hidden entry is one the board will not show the applicant, so
      // counting it would overstate the work.
      if (entry.isHidden === true) continue;
      const field = isRecord(entry.field) ? entry.field : undefined;
      const title = typeof field?.title === 'string' ? field.title.trim() : '';
      if (!title) continue;
      fields.push({
        title,
        type: toFieldType(field?.type),
        required: entry.isRequired === true,
        description: plainText(entry.descriptionHtml),
      });
    }
  }

  // A form with no readable entries means the shape moved underneath us.
  if (fields.length === 0) {
    throw new FetchError('Ashby returned a form with no readable questions — the API shape has probably changed');
  }

  return {
    provider: 'ashby',
    // `|| null`, not just `trim()`: an empty string is not nullish, so it
    // would win the `form.title ?? role.title ?? role.url` fallback at the
    // call site and print a bare `#1`.
    title: typeof posting.title === 'string' ? posting.title.trim() || null : null,
    fields,
    compensationSummary:
      typeof posting.compensationTierSummary === 'string' ? posting.compensationTierSummary : null,
    deadline: typeof posting.applicationDeadline === 'string' ? posting.applicationDeadline : null,
  };
}
