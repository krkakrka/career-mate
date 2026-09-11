import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * The two hashes that decide whether a derived value is still valid:
 * what it was computed from, and what computed it.
 */
export interface DerivationKey {
  sourceKey: string;
  recipeVersion: string;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The identity of an extraction recipe: the hash of the script file that
 * runs it. Editing a prompt therefore invalidates everything that prompt
 * produced, with nothing to remember to bump by hand.
 *
 * Read fresh on every call rather than cached at import: the daemon is
 * long-running, and a prompt edited while it is up should take effect on
 * the next job, not on the next restart.
 */
export function recipeVersion(scriptPath: string): string {
  return sha256(fs.readFileSync(scriptPath, 'utf-8'));
}

/**
 * The source key for a derivation that reads no page — the web-research,
 * tips and discover kinds, whose whole input is the JSON context handed to
 * the script on stdin. Hashing the exact string that is piped in means the
 * key changes when, and only when, the input the model saw changed.
 */
export function contextKey(contextJson: string): string {
  return sha256(contextJson);
}

/**
 * The recipe hash for a decision procedure made of more than one file —
 * closure detection is the phrase list *then* the script, so a change to
 * either one changes how the answer would be reached and must invalidate
 * what the old procedure produced, whichever half actually decided.
 */
export function combinedRecipeVersion(paths: string[], extra: string[] = []): string {
  // Contents only, never the paths themselves: embedding an absolute path
  // would make moving the checkout (or installing under a different prefix)
  // invalidate every derivation that used this recipe, and pay to recompute
  // values whose inputs and recipe are both byte-identical.
  return sha256([...paths.map((filePath) => recipeVersion(filePath)), ...extra].join('\n'));
}
