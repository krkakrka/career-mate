/**
 * Bounded retention for the two tables that grow without limit.
 *
 * `operational_logs` gets two rows per CLI invocation, one per MCP tool
 * call, and several per job; `jobs` keeps every completed row forever. Both
 * are diagnostics — useful while recent, dead weight once old — and nothing
 * has ever removed a row from either.
 *
 * **What is deliberately never pruned**, because each would cost real money
 * or break an invariant:
 *
 * - `model_calls` — the spend ledger. It is a record of money already
 *   spent, and money cannot be un-spent by deleting its row. Migration 0011
 *   made it self-contained precisely so pruning `jobs` cannot touch it.
 * - `derivations` — the memoization. Deleting one does not free anything
 *   meaningful and makes the next read pay the model again for a value
 *   already computed.
 * - `page_snapshots` and `.data/pages/` — append-only by contract.
 *   `content_hash` is a claim about exactly those bytes, and the whole
 *   staleness model rests on it.
 * - `events` — the audit log of what happened to your pipeline, which is
 *   yours rather than the tool's bookkeeping.
 *
 * Only `done` jobs go. A `failed` one is unfinished business `cm status`
 * still reports, and `pending`/`running` are live.
 *
 * One thing pruning *does* mutate beyond the rows it deletes: three tables
 * carry `job_id` with `ON DELETE SET NULL` — `derivations`,
 * `operational_logs` and `model_calls` — so removing a job strips the job
 * correlation from surviving rows in all of them. The values are untouched;
 * only the link to the job that produced them goes. Migration 0011 is why
 * that is harmless for spend attribution, which is the one place it would
 * have changed an answer.
 */

import type Database from 'better-sqlite3';

export interface PruneResult {
  cutoffIso: string;
  operationalLogs: number;
  doneJobs: number;
}

export interface PruneOptions {
  /** Report what would go without deleting anything. */
  dryRun?: boolean;
  /**
   * Return the freed pages to the filesystem afterwards.
   *
   * Off by default. SQLite reuses freed pages rather than shrinking the
   * file, so a prune bounds future growth without changing `ls -l` — and
   * `VACUUM` rewrites the whole database, which takes a write lock for as
   * long as that takes. Bounding growth is the goal; reclaiming the space
   * is a separate, heavier thing to ask for.
   */
  vacuum?: boolean;
}

export function pruneOldRecords(
  db: Database.Database,
  olderThanDays: number,
  options: PruneOptions = {},
): PruneResult {
  // Anything that is not a positive, finite number of days prunes nothing.
  //
  // Every wrong answer here is destructive in the same direction, so the
  // guard refuses rather than clamps. Clamping `-1` to `0` produced a cutoff
  // of *now*, which matches every row in the table; and `+Infinity` — which
  // plainly means "keep everything" — clamped the same way if it were
  // lumped in with `NaN`.
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    return { cutoffIso: new Date(0).toISOString(), operationalLogs: 0, doneJobs: 0 };
  }
  const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  // Log rows attached to a job that is *surviving this prune* are kept,
  // however old they are. `failed` jobs are deliberately retained — they are
  // unfinished business `cm status` still reports, with "cm worker retry
  // <id>" next to them — and deleting the rows that say why they failed
  // leaves a row you are invited to act on and cannot debug, with `cm logs
  // --job <id>` returning nothing.
  const LOGS = `FROM operational_logs
     WHERE occurred_at < ?
       AND (job_id IS NULL OR job_id NOT IN (SELECT id FROM jobs WHERE status <> 'done'))`;
  // `updated_at`, not `created_at`: a job created long ago but retried this
  // morning is recent work, and its diagnostics are what you would be
  // reading right now.
  const JOBS = "FROM jobs WHERE status = 'done' AND updated_at < ?";

  if (options.dryRun) {
    const count = (sql: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(cutoffIso) as { n: number }).n;
    return { cutoffIso, operationalLogs: count(LOGS), doneJobs: count(JOBS) };
  }

  // One transaction: a half-applied prune is not dangerous, but it makes
  // the reported counts a lie, and those counts are the only feedback.
  //
  // Logs go first, and the order is load-bearing rather than incidental:
  // deleting jobs first fires `ON DELETE SET NULL` on `operational_logs.job_id`,
  // after which the exemption above cannot tell which logs belonged to a
  // surviving job. Written as statements rather than an object literal so
  // that this does not rest on property-evaluation order.
  const run = db.transaction((): PruneResult => {
    const operationalLogs = db.prepare(`DELETE ${LOGS}`).run(cutoffIso).changes;
    const doneJobs = db.prepare(`DELETE ${JOBS}`).run(cutoffIso).changes;
    return { cutoffIso, operationalLogs, doneJobs };
  });
  const result = run.immediate();

  // Outside the transaction: VACUUM cannot run inside one.
  if (options.vacuum) db.exec('VACUUM');
  return result;
}
