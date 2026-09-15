import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import {
  MAX_REFERENCE_BYTES,
  ReferenceFileError,
  referencesDirFor,
  resolveReferencePath,
  safeFileName,
  storeReferenceFile,
} from './store.js';

/** The role's directory on disk — rows store the relative form. */
function roleDir(roleId: number): string {
  return resolveReferencePath(referencesDirFor(roleId));
}

let dataDir: string;
let sourceDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-refs-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-refs-src-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = dataDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

function sourceFile(name: string, contents = 'pdf bytes'): string {
  const file = path.join(sourceDir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('safeFileName', () => {
  it('keeps an ordinary document name readable', () => {
    expect(safeFileName('/home/me/CV 2026.pdf')).toBe('CV 2026.pdf');
  });

  it('cannot be used to climb out of the role directory', () => {
    // The whole point of taking the basename first: the destination is
    // built from this, so anything that survived would be a path the
    // caller chose.
    expect(safeFileName('../../../etc/passwd')).toBe('passwd');
    expect(safeFileName('/etc/passwd')).toBe('passwd');
    expect(path.isAbsolute(safeFileName('/a/b/c.pdf'))).toBe(false);
  });

  it('replaces characters that would confuse a shell or a filesystem', () => {
    expect(safeFileName('my;rm -rf *.pdf')).toBe('my_rm -rf _.pdf');
  });

  it('always produces something usable', () => {
    expect(safeFileName('...')).toBe('attachment');
    expect(safeFileName('')).toBe('attachment');
    expect(safeFileName('/')).toBe('attachment');
  });

  it('bounds a pathological name but keeps the extension', () => {
    // Truncating the whole string cut the extension off, so the stored file
    // no longer opened in the right application — which is the one thing
    // the naming rules promise.
    const name = safeFileName(`${'x'.repeat(500)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('storeReferenceFile', () => {
  it('copies the file, leaving the original where it was', () => {
    // A move would take the file out from under whatever else refers to it.
    const source = sourceFile('CV.pdf', 'my cv');

    const stored = storeReferenceFile(7, source);

    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(stored.absolutePath, 'utf-8')).toBe('my cv');
    expect(path.dirname(stored.absolutePath)).toBe(roleDir(7));
    // Relative in the row, so `.data` stays movable — the same rule the
    // page store follows.
    expect(stored.relativePath).toBe(path.join('files', '7', 'CV.pdf'));
    expect(path.isAbsolute(stored.relativePath)).toBe(false);
  });

  it('never overwrites an earlier attachment of the same name', () => {
    // A second version of a CV is a different document, and knowing what
    // you actually sent is the reason to keep these at all.
    const first = storeReferenceFile(7, sourceFile('CV.pdf', 'version one'));
    fs.writeFileSync(path.join(sourceDir, 'CV.pdf'), 'version two');
    const second = storeReferenceFile(7, path.join(sourceDir, 'CV.pdf'));

    expect(second.absolutePath).not.toBe(first.absolutePath);
    expect(path.basename(second.absolutePath)).toBe('CV-2.pdf');
    expect(fs.readFileSync(first.absolutePath, 'utf-8')).toBe('version one');
    expect(fs.readFileSync(second.absolutePath, 'utf-8')).toBe('version two');
  });

  it('leaves no temporary file behind', () => {
    storeReferenceFile(7, sourceFile('CV.pdf'));
    expect(fs.readdirSync(roleDir(7)).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
  });

  it('refuses a path that does not exist, without leaving a directory behind', () => {
    expect(() => storeReferenceFile(7, path.join(sourceDir, 'nope.pdf'))).toThrow(ReferenceFileError);
    expect(fs.existsSync(roleDir(7))).toBe(false);
  });

  it('refuses a directory', () => {
    expect(() => storeReferenceFile(7, sourceDir)).toThrow(/Not a file/);
  });

  it('refuses something far too large to be a document', () => {
    // `.data` must not be fillable by a mistyped path pointing at a disk
    // image.
    const big = path.join(sourceDir, 'huge.bin');
    fs.writeFileSync(big, 'x');
    fs.truncateSync(big, MAX_REFERENCE_BYTES + 1);

    expect(() => storeReferenceFile(7, big)).toThrow(/the limit is 25 MB/);
  });

  it('follows a symlink, so the copy survives the link going away', () => {
    const real = sourceFile('real.pdf', 'contents');
    const link = path.join(sourceDir, 'link.pdf');
    fs.symlinkSync(real, link);

    const stored = storeReferenceFile(7, link);
    fs.rmSync(link);

    expect(fs.readFileSync(stored.absolutePath, 'utf-8')).toBe('contents');
  });

  it('reports an unreadable source as a known error, not an uncaught throw', () => {
    // Otherwise a permission error escapes `reportKnownErrors` as a stack
    // trace and is recorded as a crash in `cm status`.
    const source = sourceFile('locked.pdf');
    fs.chmodSync(source, 0o000);
    try {
      expect(() => storeReferenceFile(7, source)).toThrow(ReferenceFileError);
    } finally {
      fs.chmodSync(source, 0o600);
    }
  });

  it('puts a traversal-shaped source inside the role directory, not above it', () => {
    // Asserted on the *directory*, because `path.join(dir, X)` starts with
    // `dir + sep` for any X including an absolute one — so a startsWith
    // check here cannot fail and proves nothing.
    const nested = path.join(sourceDir, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'CV.pdf'), 'x');

    const stored = storeReferenceFile(7, path.join(nested, '..', 'nested', '..', 'nested', 'CV.pdf'));

    expect(path.dirname(stored.absolutePath)).toBe(roleDir(7));
    expect(path.basename(stored.absolutePath)).toBe('CV.pdf');
  });
});
