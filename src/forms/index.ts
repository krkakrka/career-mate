import { fetchAshbyForm } from './ashby.js';
import { fetchGreenhouseForm } from './greenhouse.js';
import { formTargetFor } from './provider.js';
import type { ApplicationForm } from './types.js';

export { formTargetFor } from './provider.js';
export { summarizeForm } from './types.js';
export type { ApplicationForm, FormField, FormFieldType } from './types.js';

/**
 * The application form for a posting URL, or `undefined` when its board
 * does not publish one.
 *
 * Costs one HTTP request and no model call — the point of the whole
 * feature. Knowing before you sit down that a form wants three essays, a
 * GitHub link and a timezone commitment is decision support the tool had no
 * way to give.
 */
export async function fetchApplicationForm(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApplicationForm | undefined> {
  const target = formTargetFor(url);
  if (!target) return undefined;
  return target.provider === 'ashby'
    ? fetchAshbyForm(target, fetchImpl)
    : fetchGreenhouseForm(target, fetchImpl);
}
