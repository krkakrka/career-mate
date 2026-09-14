import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { allocateTracePath, pruneTraces, tracesDir } from './trace.js';

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-trace-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = dataDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Writes a placeholder trace with a given age, so pruning has something to order. */
function existingTrace(name: string, ageMinutes: number): string {
  fs.mkdirSync(tracesDir(), { recursive: true });
  const file = path.join(tracesDir(), name);
  fs.writeFileSync(file, 'zip');
  const when = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, when, when);
  return file;
}

describe('allocateTracePath', () => {
  it('names a trace by when it was taken and what it was looking at', () => {
    const file = allocateTracePath('https://www.glassdoor.com/Overview/x.htm', new Date('2026-09-14T19:44:01.123Z'));

    expect(path.dirname(file)).toBe(tracesDir());
    expect(path.basename(file)).toBe('2026-09-14T19-44-01.123Z-www.glassdoor.com.zip');
  });

  it('keeps a label that is not a URL, slugified', () => {
    // `cm auth check` passes a URL, but a caller may not have one — a
    // failed launch has no page to name itself after.
    expect(path.basename(allocateTracePath('login browser!', new Date('2026-01-02T03:04:05.000Z')))).toBe(
      '2026-01-02T03-04-05.000Z-login-browser.zip',
    );
  });

  it('never returns a path that already exists', () => {
    // Belt-and-braces: the profile lock serialises every browser call, so
    // two traces cannot be in flight at once. A silent overwrite would
    // destroy the evidence the trace exists to preserve.
    const when = new Date('2026-09-14T19:44:01.123Z');
    const first = allocateTracePath('example.com', when);
    fs.mkdirSync(path.dirname(first), { recursive: true });
    fs.writeFileSync(first, 'zip');

    const second = allocateTracePath('example.com', when);
    expect(second).not.toBe(first);
    expect(fs.existsSync(second)).toBe(false);
  });
});

describe('pruneTraces', () => {
  it('keeps the newest N and deletes the rest', () => {
    // Traces are megabytes each and nothing else ever removes them; without
    // this, turning tracing on is an unbounded disk leak.
    const newest = existingTrace('c.zip', 1);
    const middle = existingTrace('b.zip', 10);
    const oldest = existingTrace('a.zip', 100);

    expect(pruneTraces(2)).toBe(1);
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(oldest)).toBe(false);
  });

  it('does nothing when there is nothing to prune, or no directory at all', () => {
    expect(pruneTraces(5)).toBe(0);
    existingTrace('only.zip', 1);
    expect(pruneTraces(5)).toBe(0);
  });

  it('treats a keep of zero as "keep none" rather than "keep everything"', () => {
    existingTrace('a.zip', 1);
    existingTrace('b.zip', 2);
    expect(pruneTraces(0)).toBe(2);
    expect(fs.readdirSync(tracesDir())).toEqual([]);
  });

  it('leaves files that are not traces alone', () => {
    // The directory is the user's to poke around in; deleting an unrelated
    // file someone dropped there would be a surprise.
    existingTrace('a.zip', 1);
    existingTrace('notes.txt', 100);
    expect(pruneTraces(0)).toBe(1);
    expect(fs.readdirSync(tracesDir())).toEqual(['notes.txt']);
  });
});
