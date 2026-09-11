import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptsDir = fileURLToPath(new URL('./scripts', import.meta.url));

let tempDir: string;
let argvStub: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-flags-'));
  // A `claude` that prints the argv it was handed, so the exact flag set is
  // assertable without calling anything.
  argvStub = path.join(tempDir, 'claude');
  fs.writeFileSync(argvStub, '#!/usr/bin/env bash\ncat >/dev/null\nprintf "%s\\n" "$@"\n');
  fs.chmodSync(argvStub, 0o755);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function argvFor(script: string, args: string[] = [], env: Record<string, string> = {}): string[] {
  const result = spawnSync(path.join(scriptsDir, script), args, {
    input: 'page text',
    encoding: 'utf-8',
    env: { ...process.env, CM_CLAUDE_BIN: argvStub, ...env },
  });
  expect(result.status).toBe(0);
  // One arg per line, and the empty ones matter — `--tools ""` is a real
  // argument whose value is the empty string, so filtering blanks out would
  // shift every position after it.
  const lines = result.stdout.split('\n');
  lines.pop(); // the trailing newline of the last arg, not an argument
  return lines;
}

/** The value that follows a flag, as the CLI would receive it. */
function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const EXTRACTION_SCRIPTS: Array<[string, string[]]> = [
  ['extract-structural.sh', ['role']],
  ['extract-closure-status.sh', []],
  ['extract-wlb.sh', []],
];

const RESEARCH_SCRIPTS: Array<[string, string[]]> = [
  ['research-web.sh', ['role', 'find comp']],
  ['research-tips.sh', ['company']],
  ['research-discover.sh', []],
];

describe.each(EXTRACTION_SCRIPTS)('%s (extraction)', (script, args) => {
  it('uses the cheap model and grants no tools at all', () => {
    const argv = argvFor(script, args);
    expect(valueOf(argv, '--model')).toBe('haiku');
    // Page content is untrusted input; an extraction has no business
    // searching the web or touching a file.
    expect(valueOf(argv, '--tools')).toBe('');
  });
});

describe.each(RESEARCH_SCRIPTS)('%s (research)', (script, args) => {
  it('uses the stronger model and grants exactly WebSearch', () => {
    const argv = argvFor(script, args);
    expect(valueOf(argv, '--model')).toBe('sonnet');
    // Both, and they are not the same thing: --tools decides which tools
    // exist, --allowedTools which may be used without asking. With only
    // --tools the model replies "I don't have permission to use web search"
    // and answers from trained knowledge instead — verified against the
    // real CLI.
    expect(valueOf(argv, '--tools')).toBe('WebSearch');
    expect(valueOf(argv, '--allowedTools')).toBe('WebSearch');
  });
});

describe.each([...EXTRACTION_SCRIPTS, ...RESEARCH_SCRIPTS])('%s (every script)', (script, args) => {
  it('runs sandboxed and budgeted', () => {
    const argv = argvFor(script, args, { CM_MAX_BUDGET_USD: '0.25' });

    expect(argv).toContain('-p');
    expect(valueOf(argv, '--output-format')).toBe('json');
    // No user/project/local settings, so no hook or custom agent defined
    // outside this repo can be pulled into an extraction session.
    expect(valueOf(argv, '--setting-sources')).toBe('');
    expect(argv).toContain('--strict-mcp-config');
    expect(valueOf(argv, '--max-budget-usd')).toBe('0.25');
  });

  it('falls back to a budget when none is supplied', () => {
    expect(valueOf(argvFor(script, args), '--max-budget-usd')).toBe('0.50');
  });
});
