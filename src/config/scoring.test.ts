import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScoringWeights } from './scoring.js';

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-scoring-config-'));
  originalDataDir = process.env.CM_DATA_DIR;
  process.env.CM_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.CM_DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('loadScoringWeights', () => {
  it('seeds .data/config/scoring.json with defaults on first read', () => {
    const configPath = path.join(tempDir, 'config', 'scoring.json');
    expect(fs.existsSync(configPath)).toBe(false);

    const weights = loadScoringWeights();

    expect(fs.existsSync(configPath)).toBe(true);
    expect(weights).toEqual({
      comp_fit: 1,
      remote_eu_match: 1,
      ai_proof: 1,
      wlb: 1,
      preference_match: 1,
      company_preference: 1,
    });
  });

  it('reads back a user-edited value instead of overwriting it', () => {
    loadScoringWeights(); // seed the file

    const configPath = path.join(tempDir, 'config', 'scoring.json');
    const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    edited.comp_fit = 5;
    fs.writeFileSync(configPath, JSON.stringify(edited));

    const weights = loadScoringWeights();
    expect(weights.comp_fit).toBe(5);
  });

  it('fills in missing keys with defaults if the file only has some (e.g. hand-edited)', () => {
    const configDir = path.join(tempDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'scoring.json'), JSON.stringify({ comp_fit: 3 }));

    const weights = loadScoringWeights();
    expect(weights.comp_fit).toBe(3);
    expect(weights.wlb).toBe(1); // default fills in what wasn't specified
  });

  it('throws on malformed JSON instead of silently wiping the file back to defaults', () => {
    loadScoringWeights(); // seed the file, and confirm a real edit survives first
    const configPath = path.join(tempDir, 'config', 'scoring.json');
    const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    edited.comp_fit = 9;
    fs.writeFileSync(configPath, JSON.stringify(edited));

    // Now corrupt it, simulating a hand-edit typo (trailing comma).
    fs.writeFileSync(configPath, '{"comp_fit": 9,}');

    expect(() => loadScoringWeights()).toThrow(/not valid JSON/);

    // Must not have been silently overwritten by the failed read attempt.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('{"comp_fit": 9,}');
  });
});
