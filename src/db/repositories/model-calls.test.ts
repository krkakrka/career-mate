import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordDerivation } from '../../derive/record.js';
import { openDb } from '../client.js';
import { runTrackedExtraction } from '../../enrichment/tracked-extraction.js';
import { recordModelCall, spendSince } from './model-calls.js';
import { restoreEnv } from '../../../test/helpers/env.js';

let tempDir: string;
let originalDataDir: string | undefined;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-spend-'));
  // `loadSettings`/`loadPreferences` resolve through getDataDir(), and
  // loadJsonConfig *creates* the file when missing — so without this the
  // suite writes into the developer's real `.data`.
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const EPOCH = new Date(0).toISOString();

describe('spendSince', () => {
  it('is zero before anything has run', () => {
    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0, calls: 0 });
  });

  it('counts every call, including repeats of the same derivation', () => {
    const call = { entityType: 'role', entityId: 1, kind: 'role_research', model: 'sonnet', costUsd: 0.04 } as const;
    recordModelCall(db, call);
    recordModelCall(db, call);
    recordModelCall(db, call);

    // This is the whole reason the ledger exists: `derivations` upserts, so
    // summing it would report one call's cost for three calls' spending.
    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0.12, calls: 3 });
  });

  it('ignores calls older than the window', () => {
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.04 });
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(spendSince(db, future)).toEqual({ totalUsd: 0, calls: 0 });
  });
});

describe('runTrackedExtraction', () => {
  const tracking = { entityType: 'role', entityId: 1, kind: 'role_research' } as const;

  function stub(body: string): string {
    const scriptPath = path.join(tempDir, `stub-${Math.random().toString(16).slice(2)}.sh`);
    fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  const envelope = (cost: number) =>
    `cat >/dev/null\ncat <<'JSON'\n${JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"ok":true}',
      total_cost_usd: cost,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
    })}\nJSON`;

  it('records every successful call', async () => {
    await runTrackedExtraction(db, tracking, stub(envelope(0.04)), [], 'text');
    await runTrackedExtraction(db, tracking, stub(envelope(0.06)), [], 'text');

    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0.1, calls: 2 });
  });

  it('records a call that was billed and then failed', async () => {
    // An envelope reporting is_error, or an answer that is not the JSON we
    // asked for, has still been paid for — and the job will retry and pay
    // again. Recording only successes understated the total by exactly the
    // calls that cost the most.
    const billedThenUnusable = stub(
      `cat >/dev/null\ncat <<'JSON'\n${JSON.stringify({
        type: 'result',
        is_error: false,
        result: 'not json at all',
        total_cost_usd: 0.09,
        modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 5 } },
      })}\nJSON`,
    );

    await expect(runTrackedExtraction(db, tracking, billedThenUnusable, [], 'text')).rejects.toThrow();

    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0.09, calls: 1 });
  });

  it('counts a call whose cost is genuinely unknowable, without inventing a figure', async () => {
    // Killed, or an envelope that never parsed: there is no usage to read.
    await expect(runTrackedExtraction(db, tracking, stub('exit 1'), [], 'text')).rejects.toThrow();

    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0, calls: 1 });
  });

  it('survives a rollback of the transaction the caller wraps its writes in', async () => {
    await runTrackedExtraction(db, tracking, stub(envelope(0.04)), [], 'text');

    // Money already spent cannot be un-spent, so recording it must not sit
    // inside a transaction that a later failure can roll back.
    expect(() =>
      db.transaction(() => {
        recordDerivation(db, { ...tracking, key: { sourceKey: 'a', recipeVersion: 'r' } });
        throw new Error('a later statement failed');
      })(),
    ).toThrow();

    expect(spendSince(db, EPOCH)).toEqual({ totalUsd: 0.04, calls: 1 });
  });
});
