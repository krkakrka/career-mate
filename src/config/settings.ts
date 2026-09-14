import path from 'node:path';
import { numberOr, oneOfOr, positiveOr } from '../lib/config-coerce.js';
import { loadJsonConfig } from '../lib/json-config.js';
import { getDataDir } from '../lib/paths.js';
import { TRACE_MODES, type TraceMode } from '../browser/trace.js';

/** How old a page snapshot may be before a fetch takes a new one, per kind of page. */
export interface PageRefreshDays {
  /** Role postings change (and close) often, so they're re-snapshotted aggressively. */
  role: number;
  /** Company homepages are near-static; re-fetching them weekly would be pure waste. */
  company: number;
}

export interface Settings {
  recruiter_nudge_days: number;
  stale_days: number;
  reapply_cooldown_months: number;
  page_refresh_days: PageRefreshDays;
  /** Per-`claude` call spend ceiling, passed through to the enrichment scripts. */
  claude_max_budget_usd: number;
  /** Hard kill for a single `claude` call. Enrichment concurrency is 1, so one hung call stalls every other enrichment. */
  claude_timeout_seconds: number;
  /**
   * Floor on how often reading an entity may queue a paid recompute of the
   * same field group. Job pages carry churning text ("Posted 3 days ago",
   * applicant counters), and the closure check re-snapshots on every run —
   * so without a floor, every `cm roles list` could queue a fresh paid
   * extraction for every such role, forever.
   */
  recompute_min_interval_minutes: number;
  /** A job left `running` this long has outlived the daemon that claimed it (kill -9, crash) and is requeued on the next start. */
  stale_running_job_minutes: number;
  /**
   * How long the daemon stays up with nothing to do. The next `cm` command
   * starts a fresh one, so nothing is lost by exiting. **0 disables idle
   * exit** — the daemon then runs until stopped.
   */
  daemon_idle_exit_minutes: number;
  /**
   * When to write a Playwright trace for an authenticated fetch.
   *
   * `on-failure` by default. A failed browser fetch is otherwise
   * unanalysable — the exception says "Timeout 20000ms exceeded" and
   * nothing about whether the session cookie went out or a login wall came
   * back — while `always` costs megabytes per fetch for runs that worked.
   */
  browser_trace: TraceMode;
  /**
   * How many traces to keep. Nothing else deletes them, and each is
   * megabytes.
   *
   * Floored at 1 on read: a `0` here reads as "no cap" to anyone writing it
   * by hand, while meaning "delete everything" to the pruner — including
   * the trace of the run that just failed, whose path had already been
   * printed.
   */
  browser_trace_keep: number;
  /**
   * Default retention for `cm prune`, in days.
   *
   * Applies only to diagnostics — `operational_logs` and completed `jobs`.
   * The spend ledger, derivations, page snapshots and the event log are
   * never pruned; `src/db/prune.ts` says why for each.
   *
   * Must be positive. A non-positive value falls back to the default rather
   * than being clamped: clamping turned `-1` into a cutoff of *now*, which
   * deletes every row including ones written seconds earlier, and `0` is the
   * same trap from the other side — in this very file `daemon_idle_exit_minutes: 0`
   * means *disabled*, so someone writing `0` to switch pruning off would get
   * total deletion instead.
   */
  prune_after_days: number;
}

const DEFAULT_SETTINGS: Settings = {
  recruiter_nudge_days: 7,
  stale_days: 14,
  reapply_cooldown_months: 1,
  page_refresh_days: { role: 3, company: 30 },
  claude_max_budget_usd: 0.5,
  claude_timeout_seconds: 180,
  recompute_min_interval_minutes: 60,
  stale_running_job_minutes: 30,
  daemon_idle_exit_minutes: 30,
  prune_after_days: 90,
  browser_trace: 'on-failure',
  browser_trace_keep: 20,
};

export function loadSettings(): Settings {
  const settings = loadJsonConfig(path.join(getDataDir(), 'config', 'settings.json'), DEFAULT_SETTINGS);

  // loadJsonConfig merges shallowly, which is right for the flat keys but
  // would let a hand-edited `{"page_refresh_days": {"role": 1}}` drop
  // `company` entirely and yield `undefined` days. Re-merge the one nested
  // object so a partial edit means "override this key", not "delete the rest".
  return {
    ...settings,
    page_refresh_days: {
      role: numberOr(settings.page_refresh_days?.role, DEFAULT_SETTINGS.page_refresh_days.role),
      company: numberOr(settings.page_refresh_days?.company, DEFAULT_SETTINGS.page_refresh_days.company),
    },
    recruiter_nudge_days: numberOr(settings.recruiter_nudge_days, DEFAULT_SETTINGS.recruiter_nudge_days),
    stale_days: numberOr(settings.stale_days, DEFAULT_SETTINGS.stale_days),
    reapply_cooldown_months: numberOr(settings.reapply_cooldown_months, DEFAULT_SETTINGS.reapply_cooldown_months),
    claude_max_budget_usd: numberOr(settings.claude_max_budget_usd, DEFAULT_SETTINGS.claude_max_budget_usd),
    claude_timeout_seconds: numberOr(settings.claude_timeout_seconds, DEFAULT_SETTINGS.claude_timeout_seconds),
    recompute_min_interval_minutes: numberOr(
      settings.recompute_min_interval_minutes,
      DEFAULT_SETTINGS.recompute_min_interval_minutes,
    ),
    stale_running_job_minutes: numberOr(settings.stale_running_job_minutes, DEFAULT_SETTINGS.stale_running_job_minutes),
    daemon_idle_exit_minutes: numberOr(settings.daemon_idle_exit_minutes, DEFAULT_SETTINGS.daemon_idle_exit_minutes),
    prune_after_days: positiveOr(settings.prune_after_days, DEFAULT_SETTINGS.prune_after_days),
    browser_trace: oneOfOr(settings.browser_trace, TRACE_MODES, DEFAULT_SETTINGS.browser_trace),
    browser_trace_keep: Math.max(1, Math.floor(numberOr(settings.browser_trace_keep, DEFAULT_SETTINGS.browser_trace_keep))),
  };
}
