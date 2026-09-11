import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Exported so the research recipe hash can cover it: `instructions` from
 * this file are prepended to the research prompt, so they are as much part
 * of the recipe as the script is — without hashing it, editing an
 * instruction would leave every existing research derivation looking fresh
 * and the edited prompt would never run for anything already researched.
 */
export const sourcesPath = fileURLToPath(new URL('./sources.json', import.meta.url));

export interface SourceRecipe {
  requiresLogin: boolean;
  urlTemplate: string | null;
  instructions: string;
}

export type SourcesConfig = Record<string, SourceRecipe>;

/** Re-read fresh on every call (not cached) so edits to sources.json — e.g. adding a real urlTemplate — take effect without restarting the daemon. */
export function loadSources(): SourcesConfig {
  const raw = fs.readFileSync(sourcesPath, 'utf-8');
  return JSON.parse(raw) as SourcesConfig;
}

export function getSourceRecipe(name: string): SourceRecipe {
  const sources = loadSources();
  const recipe = sources[name];
  if (!recipe) throw new Error(`No source recipe named "${name}" in sources.json`);
  return recipe;
}
