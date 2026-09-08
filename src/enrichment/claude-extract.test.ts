import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExtractionError, runExtraction } from './claude-extract.js';

const fakeScript = fileURLToPath(new URL('../../test/fixtures/fake-claude-envelope.sh', import.meta.url));

describe('runExtraction', () => {
  it('parses a fenced JSON result (```json ... ```)', async () => {
    const result = await runExtraction(fakeScript, ['fenced'], '');
    expect(result).toEqual({ name: 'Test Co', description: 'A test.' });
  });

  it('parses an unfenced JSON result', async () => {
    const result = await runExtraction(fakeScript, ['unfenced'], '');
    expect(result).toEqual({ name: 'Test Co', description: 'A test.' });
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
