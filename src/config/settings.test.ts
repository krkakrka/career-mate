import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from './settings.js';
import { restoreEnv } from '../../test/helpers/env.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-settings-config-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  restoreEnv('CM_DATA_DIR', originalDataDir);
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
      page_refresh_days: { role: 3, company: 30 },
      claude_max_budget_usd: 0.5,
      claude_timeout_seconds: 180,
      recompute_min_interval_minutes: 60,
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

  it('fills in keys a settings.json written by an older version is missing', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ recruiter_nudge_days: 3 }));

    const settings = loadSettings();

    expect(settings.recruiter_nudge_days).toBe(3);
    expect(settings.page_refresh_days).toEqual({ role: 3, company: 30 });
    expect(settings.claude_max_budget_usd).toBe(0.5);
  });

  it('treats a partial page_refresh_days edit as an override, not a replacement', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ page_refresh_days: { role: 1 } }));

    // A shallow merge alone would leave `company` undefined here, and an
    // undefined refresh window silently means "never reuse a snapshot".
    expect(loadSettings().page_refresh_days).toEqual({ role: 1, company: 30 });
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
