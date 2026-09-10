import { fileURLToPath } from 'node:url';
import { runExtraction } from '../enrichment/claude-extract.js';
import phraseList from './closure-phrases.json' with { type: 'json' };

const defaultClosureScript = fileURLToPath(
  new URL('../enrichment/scripts/extract-closure-status.sh', import.meta.url),
);

export type ClosureStatus = 'open' | 'closed' | 'unknown';

/** Which rule decided — `phrase` and `http-status` cost nothing, `model` costs a `claude` call. */
export type ClosureSource = 'phrase' | 'model';

export interface ClosureVerdict {
  status: ClosureStatus;
  reason: string | null;
  source: ClosureSource;
}

interface ClosureExtraction {
  status?: ClosureStatus | null;
  reason?: string | null;
}

/**
 * Normalizes text for phrase matching so a page's typography can't hide a
 * match: curly quotes and dashes become their ASCII forms and whitespace
 * collapses, which is why every phrase in the JSON list is plain ASCII.
 */
function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ');
}

/**
 * The free half of closure detection: an unambiguous "this posting is
 * gone" phrase. Returns the matched phrase, or undefined when the page
 * says nothing definitive — which is the case that has to reach the model.
 *
 * Deliberately one-directional. There is no phrase list for "still open":
 * an "Apply now" button survives on plenty of closed postings, and a false
 * *open* verdict is invisible, while a false *closed* verdict silently
 * removes a live role from the pipeline. Both directions of error are
 * worse than paying for one model call.
 */
export function detectClosurePhrase(text: string): string | undefined {
  const haystack = normalizeForMatching(text);
  return phraseList.phrases.find((entry) => haystack.includes(entry.phrase))?.phrase;
}

export interface DecideClosureOptions {
  /** Overridable so a test can point at a script that fails loudly, proving the model was never reached. */
  scriptPath?: string;
}

/**
 * Decides whether a posting is closed from its derived text: the phrase
 * list first (free, deterministic), and only the remainder it can't settle
 * goes to `extract-closure-status.sh`.
 *
 * HTTP 404/410 is the third rule and lives in the refresh handler, because
 * it is decided by the fetch failing rather than by any text existing.
 */
export async function decideClosure(text: string, options: DecideClosureOptions = {}): Promise<ClosureVerdict> {
  const phrase = detectClosurePhrase(text);
  if (phrase) {
    return { status: 'closed', reason: `page text contains "${phrase}"`, source: 'phrase' };
  }

  const extraction = (await runExtraction(
    options.scriptPath ?? defaultClosureScript,
    [],
    text,
  )) as ClosureExtraction;

  return {
    status: extraction.status === 'closed' || extraction.status === 'open' ? extraction.status : 'unknown',
    reason: extraction.reason ?? null,
    source: 'model',
  };
}
