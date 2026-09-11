import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/client.js';
import { upsertDerivation } from '../db/repositories/derivations.js';
import { combinedRecipeVersion, recipeVersion, sha256 } from './keys.js';
import { isFresh, isStale } from './staleness.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-staleness-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const KEY = { sourceKey: 'text-hash-1', recipeVersion: 'recipe-1' };

function record(key = KEY): void {
  upsertDerivation(db, {
    entityType: 'role',
    entityId: 1,
    kind: 'role_structural',
    sourceKey: key.sourceKey,
    recipeVersion: key.recipeVersion,
  });
}

describe('isStale', () => {
  it('is stale, as never-computed, when nothing has been derived yet', () => {
    expect(isStale(db, 'role', 1, 'role_structural', KEY)).toEqual({ stale: true, reason: 'never-computed' });
  });

  it('is fresh when both keys match', () => {
    record();
    expect(isStale(db, 'role', 1, 'role_structural', KEY)).toEqual({ stale: false, reason: null });
  });

  it('is stale when the input changed', () => {
    record();
    expect(isStale(db, 'role', 1, 'role_structural', { ...KEY, sourceKey: 'text-hash-2' })).toEqual({
      stale: true,
      reason: 'source-changed',
    });
  });

  it('is stale when the recipe changed', () => {
    record();
    expect(isStale(db, 'role', 1, 'role_structural', { ...KEY, recipeVersion: 'recipe-2' })).toEqual({
      stale: true,
      reason: 'recipe-changed',
    });
  });

  it('is not stale when there is no current input to compare against', () => {
    record();
    // Nothing fetched yet: there is nothing to be inconsistent with, and a
    // recompute would have nothing to read.
    expect(isStale(db, 'role', 1, 'role_structural', undefined)).toEqual({ stale: false, reason: null });
  });
});

describe('isFresh', () => {
  it('permits skipping the model only when the whole key pair matches', () => {
    expect(isFresh(db, 'role', 1, 'role_structural', KEY)).toBe(false);
    record();
    expect(isFresh(db, 'role', 1, 'role_structural', KEY)).toBe(true);
    expect(isFresh(db, 'role', 1, 'role_structural', { ...KEY, sourceKey: 'other' })).toBe(false);
    expect(isFresh(db, 'role', 1, 'role_structural', { ...KEY, recipeVersion: 'other' })).toBe(false);
  });

  it('never skips on the strength of a missing input alone', () => {
    // isStale tolerates an unknown current key; isFresh must not, or a
    // handler would skip a call it has no evidence is unnecessary.
    record();
    expect(isFresh(db, 'role', 1, 'role_structural', { sourceKey: '', recipeVersion: '' })).toBe(false);
  });
});

describe('recipe hashing', () => {
  it('changes when the script file changes, with nothing to remember to bump', () => {
    const script = path.join(tempDir, 'extract.sh');
    fs.writeFileSync(script, '#!/usr/bin/env bash\necho one\n');
    const before = recipeVersion(script);

    fs.writeFileSync(script, '#!/usr/bin/env bash\necho two\n');

    expect(recipeVersion(script)).not.toBe(before);
  });

  it('is read fresh each call, so a prompt edited while the daemon is up takes effect on the next job', () => {
    const script = path.join(tempDir, 'extract.sh');
    fs.writeFileSync(script, 'v1');
    expect(recipeVersion(script)).toBe(sha256('v1'));
    fs.writeFileSync(script, 'v2');
    expect(recipeVersion(script)).toBe(sha256('v2'));
  });

  it('covers every file of a multi-part recipe, so a change to either half invalidates', () => {
    const phrases = path.join(tempDir, 'phrases.json');
    const script = path.join(tempDir, 'closure.sh');
    fs.writeFileSync(phrases, '["a"]');
    fs.writeFileSync(script, 'script v1');
    const before = combinedRecipeVersion([phrases, script]);

    fs.writeFileSync(phrases, '["a","b"]');
    const afterPhraseEdit = combinedRecipeVersion([phrases, script]);
    fs.writeFileSync(script, 'script v2');
    const afterScriptEdit = combinedRecipeVersion([phrases, script]);

    expect(afterPhraseEdit).not.toBe(before);
    expect(afterScriptEdit).not.toBe(afterPhraseEdit);
  });
});
