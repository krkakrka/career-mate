import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../../test/helpers/env.js';
import { captureDir, captureExtractionFailure, readExtractionBundle } from './extraction-capture.js';

let tempDir: string;
let originalDataDir: string | undefined;
let originalDebug: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-capture-'));
  originalDataDir = process.env.CM_DATA_DIR;
  originalDebug = process.env.CM_DEBUG_EXTRACTION;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
  restoreEnv('CM_DEBUG_EXTRACTION', originalDebug);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sampleInput = () => ({
  scriptPath: '/path/to/script.sh',
  args: ['role', 'the full instructions'],
  stdinContent: 'untrusted page content with é and —',
  stdout: '{"result":"garbage"}',
  error: new Error("claude -p's answer was not valid JSON"),
});

describe('captureExtractionFailure', () => {
  it('writes nothing when CM_DEBUG_EXTRACTION is unset', () => {
    delete process.env.CM_DEBUG_EXTRACTION;
    expect(captureExtractionFailure(sampleInput())).toBeNull();
    expect(fs.existsSync(captureDir())).toBe(false);
  });

  it('treats CM_DEBUG_EXTRACTION=0 and =false as disabled', () => {
    for (const value of ['0', 'false', '']) {
      process.env.CM_DEBUG_EXTRACTION = value;
      expect(captureExtractionFailure(sampleInput())).toBeNull();
    }
  });

  it('writes a replayable bundle when enabled, round-tripping every input', () => {
    process.env.CM_DEBUG_EXTRACTION = '1';
    const file = captureExtractionFailure(sampleInput());
    expect(file).not.toBeNull();

    const bundle = readExtractionBundle(file!);
    expect(bundle.scriptPath).toBe('/path/to/script.sh');
    expect(bundle.args).toEqual(['role', 'the full instructions']);
    expect(bundle.stdinContent).toBe('untrusted page content with é and —');
    expect(bundle.stdout).toBe('{"result":"garbage"}');
    expect(bundle.error).toBe("claude -p's answer was not valid JSON");
    expect(bundle.capturedAt).not.toBe('');
  });

  it('prunes to the retention cap, keeping the newest bundles', () => {
    process.env.CM_DEBUG_EXTRACTION = '1';
    for (let i = 0; i < 60; i++) captureExtractionFailure(sampleInput());
    const remaining = fs.readdirSync(captureDir()).filter((n) => n.endsWith('.json'));
    expect(remaining.length).toBeLessThanOrEqual(50);
  });

  it('never throws even when the data dir cannot be written', () => {
    process.env.CM_DEBUG_EXTRACTION = '1';
    // Point at a path whose parent is a file, so mkdir fails.
    const blocker = path.join(tempDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    process.env.CM_DATA_DIR = blocker;
    expect(captureExtractionFailure(sampleInput())).toBeNull();
  });
});
