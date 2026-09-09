import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from './settings.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-settings-config-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.CM_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('seeds .data/config/settings.json with defaults on first read', () => {
    const configPath = path.join(tempDir, 'config', 'settings.json');
    expect(fs.existsSync(configPath)).toBe(false);

    const settings = loadSettings();

    expect(fs.existsSync(configPath)).toBe(true);
    expect(settings).toEqual({
      recruiter_nudge_days: 7,
      stale_days: 14,
      reapply_cooldown_months: 1,
    });
  });

  it('reads back a user-edited value instead of overwriting it', () => {
    loadSettings();
    const configPath = path.join(tempDir, 'config', 'settings.json');
    const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    edited.recruiter_nudge_days = 3;
    fs.writeFileSync(configPath, JSON.stringify(edited));

    expect(loadSettings().recruiter_nudge_days).toBe(3);
  });

  it('throws on malformed JSON instead of silently wiping the file back to defaults', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'settings.json');
    fs.writeFileSync(configPath, '{"recruiter_nudge_days": 3,}');

    expect(() => loadSettings()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"recruiter_nudge_days": 3,}');
  });
});
