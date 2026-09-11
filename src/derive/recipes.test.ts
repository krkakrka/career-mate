import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { combinedRecipeVersion } from './keys.js';
import { researchRecipeVersion, structuralRecipeVersion } from './recipes.js';
import { PREFILL_RULES_VERSION } from './structural.js';

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

describe('structuralRecipeVersion', () => {
  it('changes when the extraction prompt changes', () => {
    const before = structuralRecipeVersion();
    temporarilyAppend(structuralScript, '\n# a prompt edit\n');
    expect(structuralRecipeVersion()).not.toBe(before);
  });

  it('covers the deterministic prefill rules, not only the script', () => {
    // The prefill pass is half of what produces a structural value, so
    // changing it has to invalidate what it produced — otherwise a new rule
    // (JSON-LD title, say) would apply only to entities added afterwards.
    // Demonstrated by the hash differing from the script's hash alone.
    expect(structuralRecipeVersion()).not.toBe(combinedRecipeVersion([structuralScript]));
    expect(structuralRecipeVersion()).toBe(
      combinedRecipeVersion([structuralScript], [`prefill-rules@${PREFILL_RULES_VERSION}`]),
    );
  });
});

describe('researchRecipeVersion', () => {
  it('changes when sources.json instructions change', () => {
    // `instructions` are prepended to the research prompt, so they are as
    // much part of the recipe as the script. Without this, editing an
    // instruction leaves every existing research derivation looking fresh
    // and the edited prompt never runs for anything already researched.
    const before = researchRecipeVersion();
    temporarilyAppend(sourcesPath, '\n');
    expect(researchRecipeVersion()).not.toBe(before);
  });

  it('is stable across calls when nothing changed', () => {
    expect(researchRecipeVersion()).toBe(researchRecipeVersion());
  });
});
