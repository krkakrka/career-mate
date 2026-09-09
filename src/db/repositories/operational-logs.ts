import type Database from 'better-sqlite3';

export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';
export type LogOutcome = 'started' | 'succeeded' | 'failed' | 'retried' | 'skipped';

export interface OperationalLogRecord {
  id: number;
  occurred_at: string;
  severity: LogSeverity;
  outcome: LogOutcome;
  component: string;
  action: string;
  job_id: number | null;
  entity_type: string | null;
  entity_id: number | null;
  context: string | null;
  error: string | null;
}

export interface RecordOperationalLogParams {
  severity?: LogSeverity;
  outcome: LogOutcome;
  component: string;
  action: string;
  jobId?: number | null;
  entityType?: string | null;
  entityId?: number | null;
  context?: unknown;
  error?: unknown;
}

export interface OperationalLogFilters {
  severity?: LogSeverity;
  component?: string;
  action?: string;
  jobId?: number;
  entityType?: string;
  entityId?: number;
  afterId?: number;
  limit?: number;
}

const SECRET_KEY = /token|secret|password|cookie|authorization|api.?key|credential/i;
const OMITTED_KEY = /^(html|content|stdout|stderr|payload|body|text|raw|response|output)$/i;
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 8;

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

/** Removes credentials and raw external content before it can reach durable storage. */
export function sanitizeOperationalValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated depth]';
  if (typeof value === 'string') {
    const withoutUrlSecrets = /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value;
    // Bearer must run BEFORE the key=value pass below: on "Authorization:
    // Bearer sk-...", the key=value regex's greedy [^\s,;]+ would otherwise
    // consume just the word "Bearer" as if it were the secret (stopping at
    // the next space), leaving the real token after it completely
    // unredacted — verified empirically. Both passes also accept an
    // optional surrounding quote so a JSON-embedded `"token":"value"` (no
    // whitespace between key and separator) still matches, not just
    // `token: value`/`token=value` text.
    const safe = withoutUrlSecrets
      .replace(/\bBearer\s+["']?[^\s,;"']+/gi, 'Bearer [redacted]')
      .replace(
        /\b(token|secret|password|cookie|authorization|api.?key|credential)\b\s*["']?\s*[=:]\s*["']?[^\s,;"']+/gi,
        '$1=[redacted]',
      );
    return safe.length > MAX_STRING_LENGTH ? `${safe.slice(0, MAX_STRING_LENGTH)}…[truncated]` : safe;
  }
  if (value instanceof Error) return sanitizeOperationalValue(value.message, depth + 1);
  if (Array.isArray(value)) return value.map((item) => sanitizeOperationalValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
        if (SECRET_KEY.test(key)) return [[key, '[redacted]']];
        if (OMITTED_KEY.test(key)) return [];
        return [[key, sanitizeOperationalValue(item, depth + 1)]];
      }),
    );
  }
  return value;
}

export function sanitizeOperationalError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(sanitizeOperationalValue(message)).slice(0, MAX_STRING_LENGTH);
}

export function recordOperationalLog(
  db: Database.Database,
  params: RecordOperationalLogParams,
): OperationalLogRecord {
  const context = params.context === undefined ? null : JSON.stringify(sanitizeOperationalValue(params.context));
  const error = params.error === undefined ? null : sanitizeOperationalError(params.error);
  const result = db
    .prepare(
      `INSERT INTO operational_logs
       (severity, outcome, component, action, job_id, entity_type, entity_id, context, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.severity ?? (params.outcome === 'failed' ? 'error' : 'info'),
      params.outcome,
      params.component,
      params.action,
      params.jobId ?? null,
      params.entityType ?? null,
      params.entityId ?? null,
      context,
      error,
    );
  return db.prepare('SELECT * FROM operational_logs WHERE id = ?').get(result.lastInsertRowid) as OperationalLogRecord;
}

/** Logging must never obscure the action or error it is meant to diagnose. */
export function tryRecordOperationalLog(db: Database.Database, params: RecordOperationalLogParams): void {
  try {
    recordOperationalLog(db, params);
  } catch {
    // best effort only
  }
}

export function listOperationalLogs(db: Database.Database, filters: OperationalLogFilters = {}): OperationalLogRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.severity) { where.push('severity = ?'); params.push(filters.severity); }
  if (filters.component) { where.push('component = ?'); params.push(filters.component); }
  if (filters.action) { where.push('action = ?'); params.push(filters.action); }
  if (filters.jobId !== undefined) { where.push('job_id = ?'); params.push(filters.jobId); }
  if (filters.entityType) { where.push('entity_type = ?'); params.push(filters.entityType); }
  if (filters.entityId !== undefined) { where.push('entity_id = ?'); params.push(filters.entityId); }
  if (filters.afterId !== undefined) { where.push('id > ?'); params.push(filters.afterId); }
  const limit = Math.max(1, Math.min(filters.limit ?? 100, 1000));
  params.push(limit);
  return db
    .prepare(`SELECT * FROM operational_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...params) as OperationalLogRecord[];
}
