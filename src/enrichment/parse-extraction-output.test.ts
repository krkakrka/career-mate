import { describe, expect, it } from 'vitest';
import { ExtractionError, parseExtractionOutput } from './claude-extract.js';

/**
 * These drive the parser with literal strings — no subprocess, no model.
 * That is the point: a captured failure bundle's `stdout` can be pasted
 * straight in here to turn a real-world garbage answer into a regression
 * test, offline and deterministic.
 */
describe('parseExtractionOutput', () => {
  const envelope = (result: unknown, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(result), ...extra });

  it('parses a well-formed envelope wrapping a JSON object', () => {
    const { data } = parseExtractionOutput(envelope({ name: 'Acme' }));
    expect(data).toEqual({ name: 'Acme' });
  });

  it('strips a ```json fence around the inner answer', () => {
    const stdout = JSON.stringify({ result: '```json\n{"name":"Acme"}\n```' });
    expect(parseExtractionOutput(stdout).data).toEqual({ name: 'Acme' });
  });

  it('throws when stdout is not a JSON envelope at all', () => {
    expect(() => parseExtractionOutput('not json <html>')).toThrow(/valid JSON envelope/);
  });

  it('throws when the envelope reports is_error', () => {
    expect(() => parseExtractionOutput(JSON.stringify({ is_error: true, result: '{}' }))).toThrow(/reported an error/);
  });

  it("throws when the inner answer is not valid JSON", () => {
    const stdout = JSON.stringify({ result: 'the company is Acme, a startup' });
    expect(() => parseExtractionOutput(stdout)).toThrow(/not valid JSON/);
  });

  it('throws when the inner answer is valid JSON but not an object', () => {
    expect(() => parseExtractionOutput(envelope(['a', 'b']))).toThrow(/not a JSON object/);
    expect(() => parseExtractionOutput(envelope(null))).toThrow(/not a JSON object/);
  });

  it('carries usage out on a post-billing failure, so spend is not understated', () => {
    const stdout = JSON.stringify({
      result: 'unparseable',
      total_cost_usd: 0.03,
      modelUsage: { 'claude-sonnet-5': { costUSD: 0.03 } },
    });
    try {
      parseExtractionOutput(stdout);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ExtractionError);
      expect((error as ExtractionError).usage).toMatchObject({ model: 'claude-sonnet-5', costUsd: 0.03 });
    }
  });
});
