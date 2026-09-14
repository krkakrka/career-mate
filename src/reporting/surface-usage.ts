/**
 * What each surface actually got used for, and what it cost.
 *
 * The question Phase 3 opened with — *is the agent actually better, and
 * what does it cost* — answered from real use rather than a synthetic
 * benchmark. A fixed task set run once would measure how well I write
 * benchmark tasks; this measures the commands and tool calls that really
 * happened, and keeps measuring as usage changes.
 *
 * Two sources, joined only at the surface:
 *
 * - **Time** comes from `operational_logs`, where every CLI action and
 *   every MCP tool call lands with a `component` and a `duration_ms`.
 * - **Money** comes from `model_calls.origin`. Neither surface spends
 *   anything directly; the daemon does, on a queue both of them feed, which
 *   is why an origin had to be recorded at all before this report could say
 *   anything true about cost. It is stamped on the ledger row itself rather
 *   than joined through `job_id` (migration 0011), so that pruning
 *   completed jobs cannot rewrite historical attribution.
 *
 * Durations are reported as median and p90, not a mean: one four-minute
 * enrichment among a hundred 30 ms reads moves a mean and tells you
 * nothing, while the pair says "usually instant, sometimes not" — which is
 * the actual difference between the two surfaces.
 *
 * **A known bias in the spend figures, worth stating because the rest of
 * this report is exact.** `enqueueJobOnce` deduplicates on payload, and
 * both surfaces queue recomputes on *read*. So if `cm roles list` queues a
 * `role_research` recompute for a role and the agent then reads the same
 * role, the second request matches the pending row and enqueues nothing —
 * and the whole cost lands on whichever surface asked first. A `failed`
 * job counts as existing too, so one exhausted job pins every later request
 * for that payload to its original caller until it is retried. The effect
 * is to over-bill whichever surface you happen to use first; attributing
 * shared work honestly would need many-to-many accounting that is not worth
 * it at one user's volume.
 */

import type Database from 'better-sqlite3';
import { ORIGINS, type Origin } from '../lib/origin.js';

/** The surfaces a person drives. `daemon` is excluded: it is work, not a way of asking for work. */
export const REPORTED_SURFACES: readonly Origin[] = ORIGINS.filter((origin) => origin !== 'daemon');

export interface SurfaceUsage {
  surface: Origin;
  /** Completed invocations — a CLI command that ran to an outcome, or one MCP tool call. */
  calls: number;
  failures: number;
  medianMs: number | null;
  p90Ms: number | null;
  /**
   * Median cost of *getting to* the work — Node bootstrap, the tsx loader,
   * module evaluation — paid once per CLI invocation and once per MCP
   * server lifetime.
   *
   * Null where nothing recorded it. Reported apart from `medianMs` rather
   * than added into it, because the two answer different questions: a slow
   * `medianMs` means the work is slow, while a large startup means the
   * *shape* of the surface is expensive however fast the work is. Leaving
   * it out made the CLI look ~65x cheaper than it is.
   */
  medianStartupMs: number | null;
  /** What the daemon spent on jobs this surface caused, including every job those chained into. */
  spendUsd: number;
  modelCalls: number;
}

export interface SurfaceUsageReport {
  sinceIso: string;
  surfaces: SurfaceUsage[];
  /**
   * Spend whose ledger row records no surface: work the daemon started for
   * itself, and anything enqueued before the origin column existed.
   *
   * A call with no job behind it is *not* in here — it is attributed to the
   * process that made it, which really is its cause.
   *
   * Reported rather than folded into a surface. The whole point is deciding
   * which surface to keep using, and a total that quietly absorbs unknowns
   * is worse than one that admits them.
   */
  unattributedSpendUsd: number;
  unattributedModelCalls: number;
}

/**
 * Nearest-rank percentile over a sorted array.
 *
 * Deliberately not interpolating: at personal volume these lists are short
 * enough that an interpolated p90 reports a duration no command ever took.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

interface DurationRow {
  component: string;
  duration_ms: number;
  outcome: string;
  context: string | null;
}

interface SpendRow {
  origin: string | null;
  total: number;
  calls: number;
}


/** The startup cost a CLI invocation recorded alongside its duration, if any. */
function startupOf(context: string | null): number | null {
  if (!context) return null;
  try {
    const value = (JSON.parse(context) as { startupMs?: unknown }).startupMs;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function buildSurfaceUsage(db: Database.Database, sinceIso: string): SurfaceUsageReport {
  // `duration_ms IS NOT NULL` is what selects *completed* invocations: the
  // `started` row written on entry carries no duration, so counting rows
  // here counts each invocation once rather than twice.
  const durations = db
    .prepare(
      `SELECT component, duration_ms, outcome, context FROM operational_logs
       WHERE duration_ms IS NOT NULL AND occurred_at >= ? AND component IN (${REPORTED_SURFACES.map(() => '?').join(', ')})`,
    )
    .all(sinceIso, ...REPORTED_SURFACES) as DurationRow[];

  // Read straight off the ledger, with no join. It used to reach through
  // `job_id` into `jobs.origin`, which made the answer to "is the agent
  // worth it" depend on the job rows still existing — and the foreign key
  // is `ON DELETE SET NULL`, so pruning completed jobs would have silently
  // moved historical spend into "unattributed".
  const spend = db
    .prepare(
      `SELECT origin, SUM(cost_usd) AS total, COUNT(*) AS calls
       FROM model_calls WHERE occurred_at >= ? GROUP BY origin`,
    )
    .all(sinceIso) as SpendRow[];

  const surfaces = REPORTED_SURFACES.map((surface) => {
    const rows = durations.filter((row) => row.component === surface);
    const sorted = rows.map((row) => row.duration_ms).sort((a, b) => a - b);
    const money = spend.find((row) => row.origin === surface);
    const startups = rows
      .map((row) => startupOf(row.context))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    return {
      surface,
      calls: rows.length,
      failures: rows.filter((row) => row.outcome === 'failed').length,
      medianMs: percentile(sorted, 0.5),
      p90Ms: percentile(sorted, 0.9),
      medianStartupMs: percentile(startups, 0.5),
      spendUsd: money?.total ?? 0,
      modelCalls: money?.calls ?? 0,
    };
  });

  const unattributed = spend.filter(
    (row) => !(REPORTED_SURFACES as readonly string[]).includes(row.origin ?? ''),
  );

  return {
    sinceIso,
    surfaces,
    unattributedSpendUsd: unattributed.reduce((sum, row) => sum + (row.total ?? 0), 0),
    unattributedModelCalls: unattributed.reduce((sum, row) => sum + row.calls, 0),
  };
}
