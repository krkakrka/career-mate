import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { combinedRecipeVersion } from './keys.js';
import { researchRecipeVersion, structuralRecipeVersion } from './recipes.js';
import { COMPANY_PREFILL_RULES_VERSION, ROLE_PREFILL_RULES_VERSION } from './structural.js';

const sourcesPath = fileURLToPath(new URL('../enrichment/sources.json', import.meta.url));
const structuralScript = fileURLToPath(new URL('../enrichment/scripts/extract-structural.sh', import.meta.url));

let restore: Array<() => void> = [];

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
});

/** Edits a real repo file for the duration of one test, restoring it afterwards. */
function temporarilyAppend(filePath: string, text: string): void {
  const original = fs.readFileSync(filePath, 'utf-8');
  restore.push(() => fs.writeFileSync(filePath, original));
  fs.writeFileSync(filePath, original + text);
}

/** Edits one recipe's `instructions` in place, restoring the file afterwards. */
function temporarilyEditInstructions(key: string): void {
  const original = fs.readFileSync(sourcesPath, 'utf-8');
  restore.push(() => fs.writeFileSync(sourcesPath, original));
  const sources = JSON.parse(original) as Record<string, { instructions: string }>;
  sources[key]!.instructions += ' (edited by a test)';
  fs.writeFileSync(sourcesPath, JSON.stringify(sources, null, 2));
}

describe('structuralRecipeVersion', () => {
  it('changes when the extraction prompt changes', () => {
    const before = structuralRecipeVersion('role');
    temporarilyAppend(structuralScript, '\n# a prompt edit\n');
    expect(structuralRecipeVersion('role')).not.toBe(before);
  });

  it('covers the deterministic prefill rules, not only the script', () => {
    // The prefill pass is half of what produces a structural value, so
    // changing it has to invalidate what it produced — otherwise a new rule
    // (JSON-LD title, say) would apply only to entities added afterwards.
    // Demonstrated by the hash differing from the script's hash alone.
    expect(structuralRecipeVersion('role')).not.toBe(combinedRecipeVersion([structuralScript]));
    expect(structuralRecipeVersion('role')).toBe(
      combinedRecipeVersion([structuralScript], [`role-prefill-rules@${ROLE_PREFILL_RULES_VERSION}`]),
    );
    expect(structuralRecipeVersion('company')).toBe(
      combinedRecipeVersion([structuralScript], [`company-prefill-rules@${COMPANY_PREFILL_RULES_VERSION}`]),
    );
  });

  it('keeps the two entity kinds independent', () => {
    // A shared constant meant a role-only rule change also marked every
    // tracked company stale and paid to re-extract it, for a
    // prefillCompanyStructural that had not changed by a byte.
    expect(structuralRecipeVersion('role')).not.toBe(structuralRecipeVersion('company'));
  });
});

describe('researchRecipeVersion', () => {
  it('changes when its own instructions change', () => {
    // `instructions` are prepended to the research prompt, so they are as
    // much part of the recipe as the script. Without this, editing an
    // instruction leaves every existing research derivation looking fresh
    // and the edited prompt never runs for anything already researched.
    const before = researchRecipeVersion('role');
    temporarilyEditInstructions('role_research');
    expect(researchRecipeVersion('role')).not.toBe(before);
  });

  it('ignores a change to another kind\'s instructions', () => {
    // `sources.json` holds all three recipes. Hashing the whole file meant
    // rewriting the WLB instructions invalidated every role and company
    // research derivation too — three kinds re-researched to change one.
    const beforeRole = researchRecipeVersion('role');
    const beforeCompany = researchRecipeVersion('company');

    temporarilyEditInstructions('company_wlb');

    expect(researchRecipeVersion('role')).toBe(beforeRole);
    expect(researchRecipeVersion('company')).toBe(beforeCompany);
    expect(researchRecipeVersion('wlb')).not.toBe(beforeRole);
  });

  it('ignores a reformat of the file that changes no instruction', () => {
    // Whitespace is not a prompt change, and treating it as one queues a
    // paid re-research for every tracked entity.
    const before = researchRecipeVersion('company');
    temporarilyAppend(sourcesPath, '\n');
    expect(researchRecipeVersion('company')).toBe(before);
  });

  it('is stable across calls when nothing changed', () => {
    expect(researchRecipeVersion('role')).toBe(researchRecipeVersion('role'));
  });
});

describe('researchRecipeVersion', () => {
  it('differs per entity kind, so a role-only rule change cannot invalidate company research', () => {
    // The same lesson as structuralRecipeVersion: one shared constant meant
    // a role change marked every tracked company stale and paid to redo it.
    expect(researchRecipeVersion('role')).not.toBe(researchRecipeVersion('company'));
  });

  it('gives every kind its own identity', () => {
    const versions = [researchRecipeVersion('role'), researchRecipeVersion('company'), researchRecipeVersion('wlb')];
    expect(new Set(versions).size).toBe(3);
  });
});
