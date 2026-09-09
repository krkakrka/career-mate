import type Database from 'better-sqlite3';

export interface InterviewNote {
  id: number;
  role_id: number;
  stage: string;
  notes: string;
  occurred_at: string;
  created_at: string;
}

export function createInterviewNote(
  db: Database.Database,
  params: { roleId: number; stage: string; notes: string; occurredAt?: string },
): InterviewNote {
  const result = db.prepare(
    `INSERT INTO interview_notes (role_id, stage, notes, occurred_at)
     VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`
  ).run(params.roleId, params.stage, params.notes, params.occurredAt ?? null);
  return db.prepare('SELECT * FROM interview_notes WHERE id = ?').get(result.lastInsertRowid) as InterviewNote;
}

export function listInterviewNotes(db: Database.Database, roleId: number): InterviewNote[] {
  return db.prepare('SELECT * FROM interview_notes WHERE role_id = ? ORDER BY occurred_at DESC, id DESC').all(roleId) as InterviewNote[];
}
