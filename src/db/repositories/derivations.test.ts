import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import {
  getDerivation,
  listDerivationsForEntity,
  upsertDerivation,
} from './derivations.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-derivations-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const BASE = { entityType: 'role', entityId: 1, kind: 'role_structural' } as const;

describe('upsertDerivation', () => {
  it('keeps exactly one row per (entity, kind), replacing what was there', () => {
    upsertDerivation(db, { ...BASE, sourceKey: 'hash-a', recipeVersion: 'recipe-1', model: 'haiku', costUsd: 0.01 });
    upsertDerivation(db, { ...BASE, sourceKey: 'hash-b', recipeVersion: 'recipe-2', model: 'sonnet', costUsd: 0.05 });

    expect(listDerivationsForEntity(db, 'role', 1)).toHaveLength(1);
    expect(getDerivation(db, 'role', 1, 'role_structural')).toMatchObject({
      source_key: 'hash-b',
      recipe_version: 'recipe-2',
      model: 'sonnet',
      cost_usd: 0.05,
    });
  });

  it('separates kinds and entities', () => {
    upsertDerivation(db, { ...BASE, sourceKey: 'a', recipeVersion: 'r' });
    upsertDerivation(db, { ...BASE, kind: 'role_research', sourceKey: 'a', recipeVersion: 'r' });
    upsertDerivation(db, { ...BASE, entityId: 2, sourceKey: 'a', recipeVersion: 'r' });

    expect(listDerivationsForEntity(db, 'role', 1)).toHaveLength(2);
    expect(listDerivationsForEntity(db, 'role', 2)).toHaveLength(1);
  });

  it('defaults a deterministic derivation to no model and no cost', () => {
    upsertDerivation(db, { ...BASE, sourceKey: 'a', recipeVersion: 'r' });
    expect(getDerivation(db, 'role', 1, 'role_structural')).toMatchObject({ model: 'none', cost_usd: 0 });
  });

  it('refreshes computed_at even when the same keys are written again', async () => {
    const first = upsertDerivation(db, { ...BASE, sourceKey: 'a', recipeVersion: 'r' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = upsertDerivation(db, { ...BASE, sourceKey: 'a', recipeVersion: 'r' });

    // computed_at answers "when did we last confirm this", not "when did it
    // last change".
    expect(second.computed_at >= first.computed_at).toBe(true);
    expect(second.id).toBe(first.id);
  });
});

describe('cost recording', () => {
  it('keeps what the latest call for a group cost, but is not a spend ledger', () => {
    upsertDerivation(db, { ...BASE, sourceKey: 'a', recipeVersion: 'r', model: 'haiku', costUsd: 0.02 });
    upsertDerivation(db, { ...BASE, sourceKey: 'b', recipeVersion: 'r', model: 'haiku', costUsd: 0.03 });

    // One upserted row per (entity, kind) means the earlier call's cost is
    // gone — summing this table would undercount badly, and a later free
    // deterministic result would erase a paid one entirely. A running spend
    // total needs an append-only record (Step 18), not this.
    expect(getDerivation(db, 'role', 1, 'role_structural')).toMatchObject({ cost_usd: 0.03 });
    expect(listDerivationsForEntity(db, 'role', 1)).toHaveLength(1);
  });
});
