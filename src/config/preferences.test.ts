import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPreferences } from './preferences.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-preferences-config-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.CM_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('loadPreferences', () => {
  it('seeds .data/config/preferences.json with defaults on first read', () => {
    const configPath = path.join(tempDir, 'config', 'preferences.json');
    expect(fs.existsSync(configPath)).toBe(false);

    const preferences = loadPreferences();

    expect(fs.existsSync(configPath)).toBe(true);
    expect(preferences).toEqual({
      titleKeywords: [],
      seniority: null,
      remoteEuRequired: false,
      minSalary: null,
    });
  });

  it('reads back a user-edited value instead of overwriting it', () => {
    loadPreferences(); // seed the file

    const configPath = path.join(tempDir, 'config', 'preferences.json');
    const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    edited.minSalary = 150_000;
    edited.titleKeywords = ['backend', 'infrastructure'];
    fs.writeFileSync(configPath, JSON.stringify(edited));

    const preferences = loadPreferences();
    expect(preferences.minSalary).toBe(150_000);
    expect(preferences.titleKeywords).toEqual(['backend', 'infrastructure']);
  });

  it('fills in missing keys with defaults if the file only has some (e.g. hand-edited)', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'preferences.json'), JSON.stringify({ minSalary: 100_000 }));

    const preferences = loadPreferences();
    expect(preferences.minSalary).toBe(100_000);
    expect(preferences.remoteEuRequired).toBe(false); // default fills in what wasn't specified
  });

  it('throws on malformed JSON instead of silently wiping the file back to defaults', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'preferences.json');
    fs.writeFileSync(configPath, '{"minSalary": 150000,}'); // trailing comma — invalid JSON

    expect(() => loadPreferences()).toThrow(/not valid JSON/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"minSalary": 150000,}');
  });
});
