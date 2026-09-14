import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../lib/paths.js';

/**
 * A frozen record of one extraction call, enough to re-run it byte-for-byte.
 *
 * Every field is a plain string or string[] — the same values `runExtraction`
 * was called with — so the bundle round-trips through JSON with no loss, and
 * `cm debug replay-extraction` can feed it straight back to the real binary.
 */
export interface ExtractionBundle {
  capturedAt: string;
  scriptPath: string;
  args: string[];
  /** The exact bytes piped to claude's stdin (page text or context JSON). */
  stdinContent: string;
  /** Raw stdout when the failure was a parse error; '' when the child failed before producing any. */
  stdout: string;
  /** The error message, so a bundle is self-describing without re-running it. */
  error: string;
}

export interface CaptureInput {
  scriptPath: string;
  args: string[];
  stdinContent: string;
  stdout: string;
  error: unknown;
}

/** Opt-in: capturing untrusted page content to disk must be a deliberate act, never on by default. */
function captureEnabled(): boolean {
  const flag = process.env.CM_DEBUG_EXTRACTION;
  return flag !== undefined && flag !== '' && flag !== '0' && flag.toLowerCase() !== 'false';
}

export function captureDir(): string {
  return path.join(getDataDir(), 'tmp', 'extraction-failures');
}

/**
 * How many failure bundles to keep. A bad run can throw on every job in a
 * batch; without a cap the directory grows without bound. Oldest are pruned.
 */
const MAX_BUNDLES = 50;

/**
 * Writes a replayable bundle for a failed extraction, when
 * `CM_DEBUG_EXTRACTION` is set. Returns the path written, or null when
 * capture is disabled or the write failed.
 *
 * Best-effort by construction: capture is a debugging aid, never allowed to
 * replace — or mask — the extraction failure it records. Every fault here is
 * swallowed. Unlike the durable error column, the bundle is intentionally
 * *un*sanitized (that is the whole point), so it lives only under the
 * gitignored `.data/` tree and is never surfaced to operational logs.
 */
export function captureExtractionFailure(input: CaptureInput): string | null {
  if (!captureEnabled()) return null;

  try {
    const dir = captureDir();
    fs.mkdirSync(dir, { recursive: true });

    const bundle: ExtractionBundle = {
      capturedAt: new Date().toISOString(),
      scriptPath: input.scriptPath,
      args: input.args,
      stdinContent: input.stdinContent,
      stdout: input.stdout,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    };

    // Colons are legal in POSIX filenames but awkward to type on the CLI
    // and invalid on other filesystems, so the timestamp uses '-' only. A
    // random suffix keeps two failures in the same millisecond from
    // colliding — enrichment concurrency is 1, but a foreground command
    // (e.g. `cm refresh`) and the daemon can each be capturing at once.
    const stamp = bundle.capturedAt.replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}-${process.pid}-${Math.random().toString(16).slice(2, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2));

    pruneOldBundles(dir);
    return file;
  } catch {
    return null;
  }
}

/** Loads a bundle from disk. Throws if the file is missing or not a valid bundle. */
export function readExtractionBundle(bundlePath: string): ExtractionBundle {
  const parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as Partial<ExtractionBundle>;
  if (typeof parsed.scriptPath !== 'string' || !Array.isArray(parsed.args) || typeof parsed.stdinContent !== 'string') {
    throw new Error(`Not a valid extraction bundle: ${bundlePath}`);
  }
  return {
    capturedAt: typeof parsed.capturedAt === 'string' ? parsed.capturedAt : '',
    scriptPath: parsed.scriptPath,
    args: parsed.args.map(String),
    stdinContent: parsed.stdinContent,
    stdout: typeof parsed.stdout === 'string' ? parsed.stdout : '',
    error: typeof parsed.error === 'string' ? parsed.error : '',
  };
}

function pruneOldBundles(dir: string): void {
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const full = path.join(dir, name);
      try {
        // A peer process can prune a file between readdir and stat; a
        // vanished entry is simply dropped rather than aborting the whole
        // prune (and, via the outer catch, discarding the path we just
        // wrote).
        return [{ full, mtime: fs.statSync(full).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of entries.slice(MAX_BUNDLES)) {
    try {
      fs.rmSync(stale.full, { force: true });
    } catch {
      /* best effort — a bundle another process is reading is fine to leave */
    }
  }
}
