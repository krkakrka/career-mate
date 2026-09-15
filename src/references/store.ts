/**
 * Where an attached file lives once career-mate has it.
 *
 * **Copied, never moved or linked.** The file you point at is yours and
 * stays exactly where it is: a move would take it out from under whatever
 * else refers to it, and a symlink would break the moment you reorganise
 * your CV folder — which is precisely when you would want to look back at
 * what you actually sent.
 *
 * Kept database-free so the naming, escaping and collision rules can be
 * tested on their own.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../lib/paths.js';

/**
 * A guard against attaching something that is not a document.
 *
 * A CV or a cover letter is kilobytes; 25 MB is far past anything that
 * belongs here, and the point is that `.data` cannot be filled by a
 * mistyped path pointing at a disk image.
 */
export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

/** Longest stored filename, before the extension is re-appended. */
const MAX_NAME_LENGTH = 100;

/** Relative to the data dir, matching `page-snapshots` — see `resolveReferencePath`. */
export function referencesDirFor(roleId: number): string {
  return path.join('files', String(roleId));
}

/**
 * Attachment paths are stored relative to the data dir, the same way
 * snapshot paths are, so `.data` stays movable and `CM_DATA_DIR`-overridable.
 *
 * Storing absolutes meant that moving `.data` — or pointing `CM_DATA_DIR`
 * at a synced copy on another machine — left every row naming a path that
 * no longer exists, and `references rm` would then delete the file at the
 * *old* location while orphaning the copy in the current one.
 */
export function resolveReferencePath(relativePath: string): string {
  return path.join(getDataDir(), relativePath);
}

/**
 * A filesystem-safe name derived from the source file.
 *
 * `path.basename` first, and that is load-bearing rather than tidy: it is
 * what stops `--file ../../../etc/passwd` from being reconstructed as a
 * destination path outside the role's own directory. Everything after it
 * only makes the name pleasant.
 *
 * The *stem* is truncated and the extension re-appended, so a pathological
 * name still opens in the right application — trimming the whole string
 * cut the extension off.
 */
export function safeFileName(sourcePath: string): string {
  const scrub = (text: string): string =>
    text
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

  const base = path.basename(sourcePath);
  const extension = scrub(path.extname(base)).slice(0, 20);
  const stem = scrub(base.slice(0, base.length - path.extname(base).length)).slice(
    0,
    Math.max(1, MAX_NAME_LENGTH - extension.length),
  );

  // A name that is only separators, or empty, still has to land somewhere.
  const cleanedStem = stem.replace(/^[.\s_-]+$/, '');
  if (!cleanedStem) return extension && extension !== '.' ? `attachment${extension}` : 'attachment';
  return `${cleanedStem}${extension}`;
}

export class ReferenceFileError extends Error {}

/**
 * Claims a name in `dir` by hard-linking `tempPath` to it.
 *
 * `link()`+EEXIST, never `existsSync`-then-write — the rule CLAUDE.md
 * states for `.data/pages/` and the same race here: two `cm references add`
 * runs (two terminals, a shell loop, the agent surface) can both see
 * `CV-2.pdf` as free, and the loser's copy would land on the winner's
 * bytes, leaving two rows describing one file with nothing to notice it.
 *
 * Linking a fully-written temp file also means no partially-copied file can
 * ever appear at a claimed name: an interrupt or ENOSPC leaves the temp
 * behind, and the claim never happens.
 */
function claimFileName(dir: string, fileName: string, tempPath: string): string {
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length) || 'attachment';

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = path.join(dir, suffix === 0 ? fileName : `${stem}-${suffix + 1}${extension}`);
    try {
      fs.linkSync(tempPath, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new ReferenceFileError(`Could not find a free filename for ${fileName} in ${dir}`);
}

export interface StoredReference {
  /** Relative to the data dir — what goes in the database. */
  relativePath: string;
  absolutePath: string;
}

/**
 * Copies `sourcePath` into the role's directory.
 *
 * Checks the source before creating anything, so a mistyped path leaves no
 * empty directory behind.
 */
export function storeReferenceFile(roleId: number, sourcePath: string): StoredReference {
  const resolved = path.resolve(sourcePath);

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new ReferenceFileError(`No such file: ${sourcePath}`);
  }
  // `statSync` follows symlinks, so this also rejects a link to a directory.
  if (!stats.isFile()) throw new ReferenceFileError(`Not a file: ${sourcePath}`);
  if (stats.size > MAX_REFERENCE_BYTES) {
    throw new ReferenceFileError(
      `${sourcePath} is ${(stats.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`,
    );
  }

  const relativeDir = referencesDirFor(roleId);
  const dir = resolveReferencePath(relativeDir);
  const temp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString('hex')}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    // `copyFile` dereferences a symlinked source, which is what we want: the
    // copy must keep working after the link is gone.
    fs.copyFileSync(resolved, temp);
  } catch (error) {
    // Wrapped so a permission error, a full disk or a read-only volume
    // reaches the user as one line rather than an uncaught stack trace
    // recorded as a crash.
    fs.rmSync(temp, { force: true });
    throw new ReferenceFileError(
      `Could not copy ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const absolutePath = claimFileName(dir, safeFileName(resolved), temp);
    return { relativePath: path.join(relativeDir, path.basename(absolutePath)), absolutePath };
  } finally {
    // The link is the file now; the temp name is just a second entry to it.
    fs.rmSync(temp, { force: true });
  }
}
