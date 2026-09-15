/**
 * Greenhouse's application form, from its **public, versioned** job board
 * API — `boards-api.greenhouse.io/v1/...?questions=true`.
 *
 * Worth saying plainly because the Backlog assumed Ashby was the only
 * option: this one is documented and versioned, so it is the *more* stable
 * of the two providers and needs none of the drift hedging Ashby's internal
 * endpoint does.
 *
 * Measured against a live Figma posting on 2026-09-14: 14 questions, 5
 * required, 2 textareas.
 */

import { FetchError } from '../pages/fetch.js';
import { plainText } from './html-text.js';
import { withTimeout } from './timeout.js';
import type { GreenhouseTarget } from './provider.js';
import type { ApplicationForm, FormField, FormFieldType } from './types.js';

function endpoint(target: GreenhouseTarget): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.board)}/jobs/${encodeURIComponent(
    target.postingId,
  )}?questions=true`;
}

/** Greenhouse's own input types, mapped to the coarse kinds worth distinguishing. */
function toFieldType(raw: unknown): FormFieldType {
  switch (String(raw)) {
    case 'textarea':
      return 'long-text';
    case 'input_file':
      return 'file';
    case 'multi_value_single_select':
    case 'multi_value_multi_select':
      return 'choice';
    case 'input_text':
    case 'input_hidden':
      return 'text';
    default:
      return 'unknown';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function fetchGreenhouseForm(
  target: GreenhouseTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<ApplicationForm> {
  const body = await withTimeout('Greenhouse', async (signal) => {
    const response = await fetchImpl(endpoint(target), {
      signal,
      headers: { 'user-agent': 'career-mate/0.1 (personal job-search tracker)' },
    });
    if (!response.ok) throw new FetchError(`Greenhouse form request failed: HTTP ${response.status}`, response.status);
    return (await response.json().catch(() => {
      throw new FetchError('Greenhouse returned a body that is not JSON');
    })) as Record<string, unknown>;
  });

  // Absent `questions` is a failure, not an empty form. The API omits the
  // key entirely unless `?questions=true` survives the request, so a
  // stripped query parameter, a redirect, or a key rename would otherwise
  // all read as "this job asks nothing".
  if (!Array.isArray(body.questions)) {
    throw new FetchError('Greenhouse returned no questions — the request or the API shape has changed');
  }
  const questions = body.questions;

  const fields: FormField[] = [];
  for (const question of questions) {
    if (!isRecord(question)) continue;
    const title = typeof question.label === 'string' ? question.label.trim() : '';
    if (!title) continue;
    // A question's `fields` array carries the actual input(s); the first is
    // the one that decides what kind of answer it wants.
    const first = Array.isArray(question.fields) && isRecord(question.fields[0]) ? question.fields[0] : undefined;
    // `input_hidden` is a board-side value, not something to fill in.
    if (String(first?.type) === 'input_hidden') continue;
    fields.push({
      title,
      type: toFieldType(first?.type),
      required: question.required === true,
      // Greenhouse returns this as HTML; the captured fixture is full of
      // `<p>` tags, which used to be printed literally at the user.
      description: plainText(question.description),
    });
  }

  if (questions.length > 0 && fields.length === 0) {
    throw new FetchError('Greenhouse returned questions in a shape with no readable labels');
  }

  return {
    provider: 'greenhouse',
    title: typeof body.title === 'string' ? body.title.trim() || null : null,
    fields,
    // Greenhouse's board API does not publish pay or a deadline; saying so
    // beats printing an empty line that looks like "none".
    compensationSummary: null,
    deadline: null,
  };
}
