import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/run-cli.js';

let dataDir: string;
let sourceDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-refs-'));
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-refs-src-'));
  runCli(['roles', 'add', 'https://example.com/jobs/1'], { dataDir });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

function sourceFile(name: string, contents = 'cv bytes'): string {
  const file = path.join(sourceDir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('cm references', () => {
  it('copies the file and leaves the original alone', () => {
    // The promise the command makes out loud, because "attached" could
    // reasonably be read as having moved it.
    const source = sourceFile('CV.pdf', 'my cv');

    const result = runCli(['references', 'add', '1', '--file', source, '--type', 'cv'], { dataDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('your original is untouched');
    expect(fs.readFileSync(source, 'utf-8')).toBe('my cv');
    expect(fs.readFileSync(path.join(dataDir, 'files', '1', 'CV.pdf'), 'utf-8')).toBe('my cv');
  });

  it('keeps both versions when the same filename is attached twice', () => {
    // A second version of a CV is a different document, and knowing what
    // you actually sent is the whole reason to keep these.
    runCli(['references', 'add', '1', '--file', sourceFile('CV.pdf', 'one'), '--type', 'cv'], { dataDir });
    fs.writeFileSync(path.join(sourceDir, 'CV.pdf'), 'two');
    runCli(['references', 'add', '1', '--file', path.join(sourceDir, 'CV.pdf'), '--type', 'cv'], { dataDir });

    expect(fs.readdirSync(path.join(dataDir, 'files', '1')).sort()).toEqual(['CV-2.pdf', 'CV.pdf']);
  });

  it('shows attachments on the role itself', () => {
    runCli(['references', 'add', '1', '--file', sourceFile('CV.pdf'), '--type', 'cv', '--notes', 'tailored'], {
      dataDir,
    });

    const show = runCli(['roles', 'show', '1'], { dataDir });
    expect(show.stdout).toContain('Attachments: 1');
    expect(show.stdout).toContain('[cv] CV.pdf');
    expect(show.stdout).toContain('tailored');
  });

  it('removes its own copy and says the original was not touched', () => {
    const source = sourceFile('CV.pdf');
    runCli(['references', 'add', '1', '--file', source, '--type', 'cv'], { dataDir });

    const removed = runCli(['references', 'rm', '1'], { dataDir });

    expect(removed.stdout).toContain('Your original file was never touched.');
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readdirSync(path.join(dataDir, 'files', '1'))).toEqual([]);
    expect(runCli(['references', 'list', '1'], { dataDir }).stdout).toContain('No files attached');
  });

  it('keeps working after the data directory is moved', () => {
    // The reason rows store a path relative to the data dir: with an
    // absolute one, moving `.data` (or pointing CM_DATA_DIR at a synced
    // copy on another machine) left every row naming a path that no longer
    // exists — and `references rm` would delete the file at the *old*
    // location while orphaning the copy in the current one.
    runCli(['references', 'add', '1', '--file', sourceFile('CV.pdf', 'my cv'), '--type', 'cv'], { dataDir });

    const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-cli-refs-moved-'));
    try {
      fs.cpSync(dataDir, moved, { recursive: true });

      const listed = runCli(['references', 'list', '1'], { dataDir: moved });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain(path.join(moved, 'files', '1', 'CV.pdf'));

      expect(runCli(['references', 'rm', '1'], { dataDir: moved }).stdout).toContain("career-mate's copy");
      // The copy in the *moved* dir goes; the one in the original stays.
      expect(fs.existsSync(path.join(moved, 'files', '1', 'CV.pdf'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'files', '1', 'CV.pdf'))).toBe(true);
    } finally {
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('reports a bad type as a usage error, not a crash', () => {
    const result = runCli(['references', 'add', '1', '--file', sourceFile('CV.pdf'), '--type', 'resume'], { dataDir });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Expected one of cv, application_answers, cover_letter, other');
    expect(result.stderr).not.toContain('at Object');
  });

  it('reports a missing file cleanly and attaches nothing', () => {
    const result = runCli(['references', 'add', '1', '--file', path.join(sourceDir, 'nope.pdf')], { dataDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No such file');
    expect(fs.existsSync(path.join(dataDir, 'files', '1'))).toBe(false);
  });

  it('refuses to attach to a role that does not exist', () => {
    const result = runCli(['references', 'add', '999', '--file', sourceFile('CV.pdf')], { dataDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No role #999');
    // Nothing copied for a role that cannot own it.
    expect(fs.existsSync(path.join(dataDir, 'files', '999'))).toBe(false);
  });
});
