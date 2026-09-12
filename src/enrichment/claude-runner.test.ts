import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { runExtraction } from './claude-extract.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-runner-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function script(body: string): string {
  const scriptPath = path.join(tempDir, `stub-${Math.random().toString(16).slice(2)}.sh`);
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeSettings(settings: Record<string, unknown>): void {
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings));
}

/** A stub that reports the environment it was actually run in, as a valid envelope. */
function reportingStub(): string {
  return script(
    `cat >/dev/null
python3 -c "import json, os; print(json.dumps({'type':'result','is_error':False,` +
      `'result': json.dumps({'cwd': os.getcwd(), 'budget': os.environ.get('CM_MAX_BUDGET_USD','')})}))"`,
  );
}

const BIG_INPUT = 'x'.repeat(500_000);

describe('runExtraction — a failing child must not take the process with it', () => {
  it('survives a child that exits before reading the 500KB piped into it', async () => {
    // Writing to a closed stdin raises EPIPE. Unhandled, that is an
    // uncaught exception — which kills the daemon, not just the job.
    const stub = script('exit 1');

    await expect(runExtraction(stub, [], BIG_INPUT)).rejects.toThrow(/exited with code 1/);

    // Still here: the rejection was delivered as a rejection.
    expect(true).toBe(true);
  });

  it('reports the tail of stderr, not just the exit code', async () => {
    const stub = script('echo "model refused: budget exceeded" >&2\nexit 1');

    // Before this, every failure read "exited with code 1" and said nothing
    // about why — leaving `cm worker failed` useless for diagnosis.
    await expect(runExtraction(stub, [], 'text')).rejects.toThrow(/budget exceeded/);
  });

  it('redacts secrets out of the stderr it reports', async () => {
    const stub = script('echo "failed with token=sk-abc123secret" >&2\nexit 1');

    const error = await runExtraction(stub, [], 'text').then(
      () => new Error('expected the extraction to fail'),
      (caught: Error) => caught,
    );

    expect(error.message).toContain('token=[redacted]');
    expect(error.message).not.toContain('sk-abc123secret');
  });
});

describe('runExtraction — timeout', () => {
  it('kills a child that runs past claude_timeout_seconds and says so', async () => {
    writeSettings({ claude_timeout_seconds: 1 });
    const stub = script('sleep 60');

    const started = Date.now();
    await expect(runExtraction(stub, [], 'text')).rejects.toThrow(/timed out after 1s/);

    // Enrichment concurrency is 1, so a hung call stalls every other
    // enrichment job until something kills it.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe('runExtraction — sandboxing', () => {
  it('runs the child in an empty scratch dir, not the project root', async () => {
    // --tools confines the file tools to the working directory, so the
    // working directory must not be the source tree or .data.
    const { data } = await runExtraction(reportingStub(), [], 'text');

    const cwd = (data as { cwd: string }).cwd;
    expect(cwd).toContain(path.join('tmp', 'claude-scratch'));
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('passes the configured budget to the script', async () => {
    writeSettings({ claude_max_budget_usd: 0.25 });
    const { data } = await runExtraction(reportingStub(), [], 'text');

    expect((data as { budget: string }).budget).toBe('0.25');
  });
});

describe('runExtraction — usage attribution', () => {
  it('attributes a call to the model that cost the money, not the one with the most tokens', async () => {
    // Measured from a real research envelope: haiku 1023 in / 14 out for
    // $0.0011, sonnet 2 in / 101 out for $0.0270. Picking by token count
    // records 96% of the spend against the wrong model.
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"ok":true}',
      total_cost_usd: 0.033,
      usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 1023, outputTokens: 14, costUSD: 0.001093 },
        'claude-sonnet-5': { inputTokens: 2, outputTokens: 101, costUSD: 0.0270244 },
      },
    });
    const stub = script(`cat >/dev/null\ncat <<'JSON'\n${envelope}\nJSON`);

    const { usage } = await runExtraction(stub, [], 'text');

    expect(usage.model).toBe('claude-sonnet-5');
    expect(usage.costUsd).toBe(0.033);
  });

  it('falls back to token count when an envelope reports no per-model cost', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '{"ok":true}',
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 20, outputTokens: 3 },
        'claude-sonnet-5': { inputTokens: 6800, outputTokens: 180 },
      },
    });
    const stub = script(`cat >/dev/null\ncat <<'JSON'\n${envelope}\nJSON`);

    expect((await runExtraction(stub, [], 'text')).usage.model).toBe('claude-sonnet-5');
  });
});
