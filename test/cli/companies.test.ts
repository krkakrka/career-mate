import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-companies-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('cm companies', () => {
  it('adds, lists, and shows a company end to end', () => {
    const add = runCli(['companies', 'add', 'https://example.com'], { dataDir });
    expect(add.exitCode).toBe(0);
    expect(add.stdout).toContain('Added company #1');

    const list = runCli(['companies', 'list'], { dataDir });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('https://example.com');

    const show = runCli(['companies', 'show', '1'], { dataDir });
    expect(show.exitCode).toBe(0);
    expect(show.stdout).toContain('https://example.com');
    expect(show.stdout).toContain('Preference rating: 0');
  });

  it('says so when nothing is tracked yet', () => {
    const result = runCli(['companies', 'list'], { dataDir });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/no companies/i);
  });

  it('is idempotent: re-adding a tracked URL prints what is there and exits 0', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });

    const second = runCli(['companies', 'add', 'https://example.com'], { dataDir });

    // `add` says "I want this tracked", and it already is — not an error.
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toMatch(/already tracking company #1/i);

    const list = runCli(['companies', 'list'], { dataDir });
    expect(list.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('rejects a non-http(s) url', () => {
    const result = runCli(['companies', 'add', 'not-a-url'], { dataDir });
    expect(result.exitCode).not.toBe(0);
  });

  it('reports a clear error for an unknown company id', () => {
    const result = runCli(['companies', 'show', '999'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('sets and reflects a preference rating', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });
    const setPref = runCli(['companies', 'set-preference', '1', '2'], { dataDir });
    expect(setPref.exitCode).toBe(0);

    const show = runCli(['companies', 'show', '1'], { dataDir });
    expect(show.stdout).toContain('Preference rating: 2');
  });

  it('rejects an out-of-range preference rating', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });
    const result = runCli(['companies', 'set-preference', '1', '5'], { dataDir });
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects setting a preference on an unknown company', () => {
    const result = runCli(['companies', 'set-preference', '999', '1'], { dataDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('sets and reflects a connections note', () => {
    runCli(['companies', 'add', 'https://example.com'], { dataDir });
    const result = runCli(['companies', 'set-connections', '1', 'Know an engineer there'], { dataDir });
    expect(result.exitCode).toBe(0);

    const show = runCli(['companies', 'show', '1'], { dataDir });
    expect(show.stdout).toContain('Know an engineer there');
  });

  it('treats trailing-slash and scheme variants as one company, but a different host as another', () => {
    // Verified working and pinned here, not newly built: the Backlog claimed
    // `https://x.com/` and `https://x.com` created two companies, and they
    // do not — `cm companies add` goes through `findCompanyByUrl`, which
    // compares normalized URLs. Nothing anywhere asserted that, so it could
    // have regressed silently and quietly re-created the duplicate-company
    // problem the enrichment path already solved.
    expect(runCli(['companies', 'add', 'https://example.com/'], { dataDir }).stdout).toContain('Added company #1');

    // `normalizeUrl` drops the scheme and trailing slashes. It does *not*
    // strip `www.`, so that is deliberately not claimed here.
    for (const variant of ['https://example.com', 'http://example.com', 'https://example.com//']) {
      const again = runCli(['companies', 'add', variant], { dataDir });
      expect(again.exitCode, variant).toBe(0);
      expect(again.stdout, variant).toContain('Already tracking company #1');
    }

    // The negative half, without which the test passes for a degenerate
    // lookup that returns the first company for anything.
    expect(runCli(['companies', 'add', 'https://other.example.org'], { dataDir }).stdout).toContain('Added company #2');
    expect(runCli(['companies', 'add', 'https://example.com/careers'], { dataDir }).stdout).toContain('Added company #3');

    expect(runCli(['companies', 'list'], { dataDir }).stdout.match(/^#\d+/gm)?.length).toBe(3);
  });
});
