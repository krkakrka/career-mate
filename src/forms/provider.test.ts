import { describe, expect, it } from 'vitest';
import { formTargetFor } from './provider.js';

describe('formTargetFor', () => {
  it('reads a real Ashby posting URL', () => {
    expect(formTargetFor('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')).toEqual({
      provider: 'ashby',
      board: 'ramp',
      postingId: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
    });
  });

  it('accepts the /application variant, which is where the form actually lives', () => {
    expect(
      formTargetFor('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application')?.postingId,
    ).toBe('34413f8d-26bf-4bbc-8ade-eb309a0e2245');
  });

  it('refuses an Ashby URL whose second segment is not a posting id', () => {
    // `jobs.ashbyhq.com/ramp` is the board index and
    // `/ramp/engineering` a department filter. Treating either as a posting
    // id would send a lookup for a posting that does not exist.
    expect(formTargetFor('https://jobs.ashbyhq.com/ramp')).toBeUndefined();
    expect(formTargetFor('https://jobs.ashbyhq.com/ramp/engineering')).toBeUndefined();
  });

  it('reads both Greenhouse URL shapes, and the gh_jid fallback', () => {
    expect(formTargetFor('https://boards.greenhouse.io/figma/jobs/5426468004')).toEqual({
      provider: 'greenhouse',
      board: 'figma',
      postingId: '5426468004',
    });
    expect(formTargetFor('https://job-boards.greenhouse.io/figma/jobs/5426468004')?.board).toBe('figma');
    // The canonical id when the path carries a slug instead.
    expect(formTargetFor('https://boards.greenhouse.io/figma/jobs/slug-form?gh_jid=5426468004')?.postingId).toBe(
      '5426468004',
    );
  });

  it('is unaffected by trailing or doubled slashes', () => {
    // Without filtering empties, one extra separator shifts every segment
    // and turns a valid URL into a lookup for the wrong thing.
    expect(formTargetFor('https://jobs.ashbyhq.com//ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/')?.board).toBe('ramp');
  });

  it('ignores a www prefix', () => {
    expect(formTargetFor('https://www.jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')?.provider).toBe(
      'ashby',
    );
  });

  it('says nothing for a board with no form API, rather than guessing', () => {
    // Most postings are like this. Lever publishes postings but not their
    // questions, and a company's own careers page publishes neither — "this
    // board does not expose its form" is an ordinary answer.
    for (const url of [
      'https://jobs.lever.co/netlify/abc123',
      'https://example.com/careers/engineer',
      'https://boards.greenhouse.io/figma',
      'not a url at all',
    ]) {
      expect(formTargetFor(url), url).toBeUndefined();
    }
  });

  it('refuses a Greenhouse host whose API region it cannot name', () => {
    // Board tokens are namespaced per region, so looking an EU posting up on
    // the US API is a 404 at best and another company's same-slug board at
    // worst. Supporting it means verifying the regional API host, not
    // assuming one.
    expect(formTargetFor('https://job-boards.eu.greenhouse.io/figma/jobs/5426468004')).toBeUndefined();
  });

  it('does not mistake a lookalike host for the real one', () => {
    // `hostMatches` requires a dot boundary, so an attacker-controlled
    // `ashbyhq.com.evil.test` is not Ashby — and this decides where a
    // request gets sent.
    expect(formTargetFor('https://ashbyhq.com.evil.test/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')).toBeUndefined();
    expect(formTargetFor('https://notashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')).toBeUndefined();
  });
});
