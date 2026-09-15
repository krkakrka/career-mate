/**
 * A deadline for a form request.
 *
 * `fetchRawPage` has had one since the beginning; these two endpoints did
 * not, so a hung board left `cm roles form <id>` blocked forever with no
 * output and no way to tell it from a slow response.
 */

import { FetchError } from '../pages/fetch.js';

/** Matches `fetchRawPage`'s budget, so one slow host behaves the same everywhere. */
export const FORM_TIMEOUT_MS = 15_000;

export async function withTimeout<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORM_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (error) {
    // Reported as a timeout rather than as the generic abort error, which
    // names neither the endpoint nor the reason.
    if (controller.signal.aborted) {
      throw new FetchError(`${label} did not respond within ${FORM_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
