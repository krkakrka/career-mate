import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a JSON config file, seeding it with `defaults` if missing (ENOENT
 * — the expected first-run case). Any *other* read/parse error (malformed
 * JSON from a hand-edit typo, permissions, etc.) throws clearly instead of
 * being silently treated the same as "missing" — conflating the two means
 * a typo in a file the user was deliberately hand-tuning (scoring
 * weights, preferences) gets silently wiped back to defaults with no
 * warning, which is real data loss, not a cosmetic bug.
 */
export function loadJsonConfig<T extends object>(configPath: string, defaults: T): T {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    throw error;
  }

  let parsed: Partial<T>;
  try {
    parsed = JSON.parse(raw) as Partial<T>;
  } catch (error) {
    throw new Error(
      `${configPath} is not valid JSON. Fix it by hand, or delete it to regenerate defaults. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return { ...defaults, ...parsed };
}
