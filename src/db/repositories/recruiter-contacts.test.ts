import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../client.js';
import { createCompany } from './companies.js';
import {
  createRecruiterContact,
  getRecruiterContactById,
  listRecruiterContacts,
  markRecruiterContactResponded,
} from './recruiter-contacts.js';
import { createRole } from './roles.js';

let tempDir: string;
let db: Database.Database;
let roleId: number;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-recruiter-contacts-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
  const company = createCompany(db, 'https://example.com');
  roleId = createRole(db, { companyId: company.id, url: 'https://example.com/jobs/1' }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createRecruiterContact / getRecruiterContactById', () => {
  it('creates a contact with the given fields and no response yet', () => {
    const contact = createRecruiterContact(db, {
      roleId,
      recruiterName: 'Jane Recruiter',
      channel: 'LinkedIn',
      link: 'https://linkedin.com/messaging/thread/1',
      notes: 'Reached out about the SWE role',
    });

    expect(contact.role_id).toBe(roleId);
    expect(contact.recruiter_name).toBe('Jane Recruiter');
    expect(contact.channel).toBe('LinkedIn');
    expect(contact.responded_at).toBeNull();
    expect(getRecruiterContactById(db, contact.id)?.id).toBe(contact.id);
  });

  it('allows optional fields to be omitted', () => {
    const contact = createRecruiterContact(db, { roleId, recruiterName: 'Anon Recruiter' });
    expect(contact.channel).toBeNull();
    expect(contact.link).toBeNull();
    expect(contact.notes).toBeNull();
  });
});

describe('markRecruiterContactResponded', () => {
  it('sets responded_at on an existing contact', () => {
    const contact = createRecruiterContact(db, { roleId, recruiterName: 'Jane' });
    expect(contact.responded_at).toBeNull();

    const updated = markRecruiterContactResponded(db, contact.id);
    expect(updated?.responded_at).not.toBeNull();
  });

  it('returns undefined for an unknown contact id', () => {
    expect(markRecruiterContactResponded(db, 999)).toBeUndefined();
  });

  it('is idempotent — calling it again does not overwrite the original responded_at', () => {
    const contact = createRecruiterContact(db, { roleId, recruiterName: 'Jane' });
    const firstResponse = markRecruiterContactResponded(db, contact.id);
    const originalRespondedAt = firstResponse?.responded_at;
    expect(originalRespondedAt).not.toBeNull();

    // Backdate it so a bug that re-stamps "now" would be obviously detectable.
    db.prepare("UPDATE recruiter_contacts SET responded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 days') WHERE id = ?").run(
      contact.id,
    );
    const backdated = db.prepare('SELECT responded_at FROM recruiter_contacts WHERE id = ?').get(contact.id) as {
      responded_at: string;
    };

    const secondResponse = markRecruiterContactResponded(db, contact.id);
    expect(secondResponse?.responded_at).toBe(backdated.responded_at); // unchanged, not reset to "now"
  });
});

describe('listRecruiterContacts', () => {
  it('lists all contacts, most recent first, when given no filters', () => {
    createRecruiterContact(db, { roleId, recruiterName: 'First' });
    db.exec("UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')");
    createRecruiterContact(db, { roleId, recruiterName: 'Second' });

    const contacts = listRecruiterContacts(db);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]?.recruiter_name).toBe('Second');
  });

  it('filters by roleId', () => {
    const company = createCompany(db, 'https://other.example.com');
    const otherRoleId = createRole(db, { companyId: company.id, url: 'https://other.example.com/jobs/1' }).id;
    createRecruiterContact(db, { roleId, recruiterName: 'ForRoleA' });
    createRecruiterContact(db, { roleId: otherRoleId, recruiterName: 'ForRoleB' });

    const contacts = listRecruiterContacts(db, { roleId });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]?.recruiter_name).toBe('ForRoleA');
  });

  it('filters to only overdue (no response, older than overdueDays), oldest first', () => {
    const respondedRecently = createRecruiterContact(db, { roleId, recruiterName: 'Responded' });
    markRecruiterContactResponded(db, respondedRecently.id);

    const overdue = createRecruiterContact(db, { roleId, recruiterName: 'Overdue' });
    db.prepare(
      "UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?",
    ).run(overdue.id);

    const recentUnresponded = createRecruiterContact(db, { roleId, recruiterName: 'Recent' });

    const results = listRecruiterContacts(db, { overdueDays: 7 });
    expect(results).toHaveLength(1);
    expect(results[0]?.recruiter_name).toBe('Overdue');
    // sanity: the other two really shouldn't show up
    expect(results.some((c) => c.id === respondedRecently.id)).toBe(false);
    expect(results.some((c) => c.id === recentUnresponded.id)).toBe(false);
  });

  it('combines roleId and overdueDays filters', () => {
    const company = createCompany(db, 'https://other2.example.com');
    const otherRoleId = createRole(db, { companyId: company.id, url: 'https://other2.example.com/jobs/1' }).id;

    const overdueOtherRole = createRecruiterContact(db, { roleId: otherRoleId, recruiterName: 'OtherOverdue' });
    db.prepare(
      "UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?",
    ).run(overdueOtherRole.id);

    const overdueThisRole = createRecruiterContact(db, { roleId, recruiterName: 'ThisOverdue' });
    db.prepare(
      "UPDATE recruiter_contacts SET contacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 days') WHERE id = ?",
    ).run(overdueThisRole.id);

    const results = listRecruiterContacts(db, { roleId, overdueDays: 7 });
    expect(results).toHaveLength(1);
    expect(results[0]?.recruiter_name).toBe('ThisOverdue');
  });
});
