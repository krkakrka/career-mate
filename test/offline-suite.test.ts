import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.py', import.meta.url));
const structuralScript = fileURLToPath(new URL('../src/enrichment/scripts/extract-structural.sh', import.meta.url));

let logPath: string;

beforeEach(() => {
  logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-offline-')), 'calls.log');
});

afterEach(() => {
  fs.rmSync(path.dirname(logPath), { recursive: true, force: true });
});

/**
 * Guards the property the whole default suite depends on. If CM_CLAUDE_BIN
 * ever stops being wired up, every extraction test quietly turns back into
 * a paid, networked, nondeterministic call — and the suite keeps passing,
 * so nothing would tell you.
 */
describe('the default test suite is offline', () => {
  it('points every extraction at the fake claude, not the real binary', () => {
    expect(process.env.CM_CLAUDE_BIN).toBe(fakeClaude);
    expect(fs.existsSync(fakeClaude)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(fs.statSync(fakeClaude).mode & 0o111).toBeGreaterThan(0);
  });

  it('actually routes a real extraction script through it', () => {
    const stdout = execFileSync(structuralScript, ['role'], {
      input: 'Engineer\nCompany homepage: https://globex.example.com',
      encoding: 'utf-8',
      env: { ...process.env, CM_FAKE_CLAUDE_LOG: logPath },
    });

    // The envelope came from the fake...
    expect(JSON.parse(stdout).result).toContain('fake-claude');
    // ...and the fake was genuinely the process that ran, not something
    // that merely looked like it.
    expect(fs.readFileSync(logPath, 'utf-8')).toContain('--output-format json');
  });

  it('refuses to invent an answer for a prompt it does not recognise', () => {
    // A fake that answered anything would let a prompt rewrite silently
    // pass tests while the real model got an unanswerable question.
    expect(() =>
      execFileSync(fakeClaude, ['-p', 'something entirely unrelated', '--output-format', 'json'], {
        input: '',
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    ).toThrow();
  });
});
