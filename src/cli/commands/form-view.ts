/**
 * How an application form reads on a terminal.
 *
 * Separated from the command so it can be tested: this is where a live
 * Ramp posting's 2 KB base64 field title gets bounded, and that mitigation
 * had no coverage while it lived inline in an action that hard-codes a
 * network call.
 */

import type { ApplicationForm, FormField } from '../../forms/index.js';
import { summarizeForm } from '../../forms/index.js';

/**
 * How much of a question's text to show.
 *
 * Field titles are arbitrary text a board lets an employer write, and they
 * are not always a question: one live Ramp posting embeds a 2 KB base64
 * blob as a title, which floods the terminal and buries every other line of
 * the form. Found by running the command against a real posting.
 */
export const MAX_FIELD_TEXT = 160;

export function clip(text: string): string {
  // Collapsed first: a title carrying newlines would otherwise break the
  // one-line-per-question layout regardless of length.
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_FIELD_TEXT ? flat : `${flat.slice(0, MAX_FIELD_TEXT - 1)}…`;
}

function fieldLines(field: FormField): string[] {
  const lines = [`  ${field.required ? '*' : ' '} [${field.type.padEnd(9)}] ${clip(field.title)}`];
  if (field.description) lines.push(`      ${clip(field.description)}`);
  return lines;
}

/** The whole rendered view, as lines, so a test can read it without capturing stdout. */
export function renderForm(form: ApplicationForm, heading: string, url: string): string[] {
  const counts = summarizeForm(form);
  const lines = [heading, `Source: ${form.provider}`];
  if (form.compensationSummary) lines.push(`Pay (as stated): ${form.compensationSummary}`);
  if (form.deadline) lines.push(`Applications close: ${form.deadline}`);
  // The headline is the point of the command: this is how you decide
  // whether tonight is the night.
  lines.push(
    '',
    `${counts.total} question(s), ${counts.required} required` +
      ` — ${counts.essays} long-form answer(s) and ${counts.files} file(s) among them`,
    '',
  );
  for (const field of form.fields) lines.push(...fieldLines(field));
  lines.push('', '* = required', `Full wording is on the posting: ${url}`);
  return lines;
}
