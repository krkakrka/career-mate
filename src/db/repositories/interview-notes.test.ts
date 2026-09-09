import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { createCompany } from './companies.js';
import { createInterviewNote, listInterviewNotes } from './interview-notes.js';
import { createRole } from './roles.js';

let tempDir: string;
let db: Database.Database;
let roleId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-interview-notes-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
  const company = createCompany(db, 'https://example.com');
  roleId = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/1' }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createInterviewNote', () => {
  it('creates a note with the given stage and notes', () => {
    const note = createInterviewNote(db, { roleId, stage: 'phone screen', notes: 'Went well, asked about X' });
    expect(note.role_id).toBe(roleId);
    expect(note.stage).toBe('phone screen');
    expect(note.notes).toBe('Went well, asked about X');
    expect(note.occurred_at).toBeTruthy();
  });
});

describe('listInterviewNotes', () => {
  it('returns notes for a role, most recent first', () => {
    createInterviewNote(db, { roleId, stage: 'phone screen', notes: 'First' });
    db.exec("UPDATE interview_notes SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')");
    createInterviewNote(db, { roleId, stage: 'onsite', notes: 'Second' });

    const notes = listInterviewNotes(db, roleId);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.notes).toBe('Second');
  });

  it('scopes to the given role only', () => {
    const company = createCompany(db, 'https://other.example.com');
    const otherRoleId = createRole(db, { companyId: company.id, url: 'https://other.example.com/jobs/1' }).id;
    createInterviewNote(db, { roleId, stage: 'phone screen', notes: 'For this role' });
    createInterviewNote(db, { roleId: otherRoleId, stage: 'phone screen', notes: 'For other role' });

    const notes = listInterviewNotes(db, roleId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.notes).toBe('For this role');
  });

  it('returns an empty array when there are no notes yet', () => {
    expect(listInterviewNotes(db, roleId)).toEqual([]);
  });
});
