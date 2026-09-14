import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import phraseList from './closure-phrases.json' with { type: 'json' };
import { decideClosure, detectClosurePhrase } from './closure.js';
import { restoreEnv } from '../../test/helpers/env.js';

let tempDir: string;
let originalDataDir: string | undefined;
/** A stand-in for extract-closure-status.sh that fails loudly, so reaching the model path is unmissable. */
let loudScript: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-closure-'));
  // `loadSettings`/`loadPreferences` resolve through getDataDir(), and
  // loadJsonConfig *creates* the file when missing — so without this the
  // suite writes into the developer's real `.data`.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  loudScript = path.join(tempDir, 'must-not-run.sh');
  fs.writeFileSync(loudScript, '#!/usr/bin/env bash\necho "MODEL WAS CALLED" >&2\nexit 42\n');
  fs.chmodSync(loudScript, 0o755);
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('detectClosurePhrase', () => {
  it.each(phraseList.phrases)('recognizes "$phrase" (seen on $seenOn)', async ({ phrase }) => {
    const text = `title: Senior Engineer\n\nSenior Engineer\n${phrase}\nBrowse other openings.`;
    expect(detectClosurePhrase(text)).toBe(phrase);
  });

  it('contains no phrase that another phrase already covers', () => {
    // A phrase containing a shorter one can never be the match reported,
    // so it is dead weight in the list and a misleading `seenOn` note.
    const phrases = phraseList.phrases.map((entry) => entry.phrase);
    const shadowed = phrases.filter((phrase) => phrases.some((other) => other !== phrase && phrase.includes(other)));
    expect(shadowed).toEqual([]);
  });

  it('matches regardless of case, curly punctuation or line wrapping', () => {
    expect(detectClosurePhrase('We’re NO LONGER   ACCEPTING\nAPPLICATIONS for this role.')).toBe(
      'no longer accepting applications',
    );
  });

  it.each([
    ['a search widget empty state', 'Senior Engineer\nApply now.\nJob not found — try another search.'],
    ['a sibling posting being closed', 'Applications are closed for our internship program, but this role is open.'],
  ])('does not close a live posting on %s', (_case, text) => {
    // A false *closed* verdict silently removes a live role from the
    // pipeline; a phrase that misses just costs one model call. The list
    // must only hold phrases that cannot appear on a live page.
    expect(detectClosurePhrase(text)).toBeUndefined();
  });

  it('is undefined for a page that is still open', () => {
    expect(detectClosurePhrase('Senior Engineer\nApply now — we review every application.')).toBeUndefined();
  });

  it('does not treat an "Apply now" button as proof a posting is open', () => {
    // One-directional by design: closed phrases only. An apply button
    // survives on plenty of closed postings, so there is no "open" list.
    expect(detectClosurePhrase('This job has been filled.\nApply now')).toBe('this job has been filled');
  });
});

describe('decideClosure', () => {
  it('settles a closed posting from the phrase list without spawning the model', async () => {
    const verdict = await decideClosure('This job has been filled.', { scriptPath: loudScript });

    expect(verdict).toEqual({
      status: 'closed',
      reason: 'page text contains "this job has been filled"',
      source: 'phrase',
    });
    // No usage at all, rather than a zero-cost one: nothing was called.
    expect(verdict.usage).toBeUndefined();
  });

  it('sends a page the phrase list cannot settle to the model', async () => {
    // The loud script exits non-zero, which is exactly how we know the
    // model path was taken rather than short-circuited.
    await expect(
      decideClosure('Senior Engineer\nWe are hiring across Europe.', { scriptPath: loudScript }),
    ).rejects.toThrow(/exited with code 42/);
  });

  it('reports an unrecognized model answer as unknown rather than guessing', async () => {
    const stub = path.join(tempDir, 'stub.sh');
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s' '{"type":"result","result":"{\\"status\\":\\"maybe\\",\\"reason\\":\\"unclear\\"}"}'\n`,
    );
    fs.chmodSync(stub, 0o755);

    expect(await decideClosure('An ambiguous page.', { scriptPath: stub })).toMatchObject({
      status: 'unknown',
      reason: 'unclear',
      source: 'model',
    });
  });
});
