import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { ExtractionError, runExtraction } from './claude-extract.js';

const fakeScript = fileURLToPath(new URL('../../test/fixtures/fake-claude-envelope.sh', import.meta.url));

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  // `runExtraction` reads `claude_timeout_seconds` from settings, and
  // `loadJsonConfig` *creates* `settings.json` when missing — so without a
  // temp data dir this suite writes into the developer's real `.data`.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-extract-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runExtraction', () => {
  it('parses a fenced JSON result (```json ... ```)', async () => {
    const { data } = await runExtraction(fakeScript, ['fenced'], '');
    expect(data).toEqual({ name: 'Test Co', description: 'A test.' });
  });

  it('parses an unfenced JSON result', async () => {
    const { data } = await runExtraction(fakeScript, ['unfenced'], '');
    expect(data).toEqual({ name: 'Test Co', description: 'A test.' });
  });

  it('reports what the call cost, for the derivation row that records it', async () => {
    const { usage } = await runExtraction(fakeScript, ['unfenced'], '');
    // The fixture envelope carries no cost fields, which must read as zero
    // spend rather than NaN — a missing field is not an unknown price.
    expect(usage).toEqual({ model: null, costUsd: 0, inputTokens: null, outputTokens: null });
  });

  it('throws ExtractionError when the envelope reports is_error', async () => {
    await expect(runExtraction(fakeScript, ['error'], '')).rejects.toThrow(ExtractionError);
  });

  it('throws ExtractionError when stdout is not valid JSON at all', async () => {
    await expect(runExtraction(fakeScript, ['bad-json'], '')).rejects.toThrow(ExtractionError);
  });

  it('throws ExtractionError when the inner result is not valid JSON', async () => {
    await expect(runExtraction(fakeScript, ['bad-inner-json'], '')).rejects.toThrow(ExtractionError);
  });

  it('throws ExtractionError when the script exits non-zero', async () => {
    await expect(runExtraction(fakeScript, ['fail-exit'], '')).rejects.toThrow(ExtractionError);
  });

  it('throws ExtractionError when the inner result is valid JSON but not an object (bare null)', async () => {
    await expect(runExtraction(fakeScript, ['null-result'], '')).rejects.toThrow(ExtractionError);
  });

  it('throws ExtractionError when the inner result is valid JSON but not an object (array)', async () => {
    await expect(runExtraction(fakeScript, ['array-result'], '')).rejects.toThrow(ExtractionError);
  });
});
