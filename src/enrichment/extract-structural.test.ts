import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./scripts/extract-structural.sh', import.meta.url));

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-structural-script-'));
  // A `claude` that just echoes the prompt it was handed, so the test can
  // assert what the model would actually have been asked. Injected through
  // CM_CLAUDE_BIN, the same override the suite-wide fake uses — a PATH stub
  // would be silently bypassed by it.
  const stub = path.join(tempDir, 'claude');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\ncat >/dev/null\nprintf "%s" "$2"\n');
  fs.chmodSync(stub, 0o755);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function promptFor(...args: string[]): { prompt: string; status: number | null; stderr: string } {
  const result = spawnSync(script, args, {
    input: 'title: Staff Engineer\n\nStaff Engineer\nJoin us.',
    encoding: 'utf-8',
    env: { ...process.env, CM_CLAUDE_BIN: path.join(tempDir, 'claude') },
  });
  return { prompt: result.stdout, status: result.status, stderr: result.stderr };
}

describe('extract-structural.sh field subsetting', () => {
  it('asks for every field when none are specified', () => {
    const { prompt } = promptFor('role');
    for (const field of ['title', 'description', 'companyName', 'companyUrl']) {
      expect(prompt).toContain(`"${field}"`);
    }
  });

  it('omits a field the deterministic pass already filled', () => {
    const { prompt } = promptFor('role', 'description,companyName,companyUrl');

    // Not just "asked and discarded" — the word must be absent from the
    // prompt and from the requested response shape entirely.
    expect(prompt).not.toContain('"title"');
    expect(prompt).toContain('{"description": string|null, "companyName": string|null, "companyUrl": string|null}');
  });

  it('describes a single remaining field on its own', () => {
    const { prompt } = promptFor('company', 'description');
    expect(prompt).not.toContain('"name"');
    expect(prompt).toContain('{"description": string|null}');
    expect(prompt).toContain('what the company does');
  });

  it('gives description the wording that matches the entity kind', () => {
    expect(promptFor('role', 'description').prompt).toContain('responsibilities');
    expect(promptFor('company', 'description').prompt).toContain('what the company does');
  });

  it('fails loudly on an unknown field rather than silently asking for nothing', () => {
    const { status, stderr } = promptFor('role', 'salaryMax');
    expect(status).toBe(1);
    expect(stderr).toContain('unknown field: salaryMax');
  });

  it('fails on an unknown entity kind', () => {
    expect(promptFor('recruiter').status).toBe(1);
  });
});
