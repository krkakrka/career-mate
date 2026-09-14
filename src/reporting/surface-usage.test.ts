import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/client.js';
import { enqueueJob } from '../db/repositories/jobs.js';
import { recordModelCall, spendSince } from '../db/repositories/model-calls.js';
import { recordOperationalLog } from '../db/repositories/operational-logs.js';
import { withOrigin } from '../lib/origin.js';
import { buildSurfaceUsage } from './surface-usage.js';

let tempDir: string;
let db: Database.Database;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-mate-surface-'));
  db = openDb(path.join(tempDir, 'career-mate.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const EPOCH = '2000-01-01T00:00:00.000Z';

function invocation(
  component: 'cli' | 'mcp',
  durationMs: number,
  outcome: 'succeeded' | 'failed' = 'succeeded',
  startupMs?: number,
): void {
  // The `started` row every invocation also writes, which carries no
  // duration — present so the count cannot accidentally double.
  recordOperationalLog(db, { outcome: 'started', component, action: 'x' });
  recordOperationalLog(db, {
    outcome,
    component,
    action: 'x',
    durationMs,
    severity: outcome === 'failed' ? 'error' : 'info',
    ...(startupMs === undefined ? {} : { context: { startupMs } }),
  });
}

describe('buildSurfaceUsage', () => {
  it('counts each invocation once, not once per log row', () => {
    invocation('cli', 10);
    invocation('cli', 20);

    const cli = buildSurfaceUsage(db, EPOCH).surfaces.find((s) => s.surface === 'cli')!;
    expect(cli.calls).toBe(2);
  });

  it('reports median and p90 rather than a mean', () => {
    // One four-minute enrichment among a hundred instant reads moves a mean
    // and tells you nothing; the pair says "usually instant, sometimes not",
    // which is the actual difference between the surfaces.
    for (const ms of [10, 20, 30, 40, 50, 60, 70, 80, 90, 4000]) invocation('cli', ms);

    const cli = buildSurfaceUsage(db, EPOCH).surfaces.find((s) => s.surface === 'cli')!;
    expect(cli.medianMs).toBe(50);
    // Nearest-rank, so p90 is a duration something actually took — not an
    // interpolated figure no command ever produced.
    expect(cli.p90Ms).toBe(90);
  });

  it('separates failures from the call count', () => {
    invocation('mcp', 5);
    invocation('mcp', 7, 'failed');

    const mcp = buildSurfaceUsage(db, EPOCH).surfaces.find((s) => s.surface === 'mcp')!;
    expect(mcp.calls).toBe(2);
    expect(mcp.failures).toBe(1);
  });

  it('bills a job chain to the surface that started it, not to the daemon', () => {
    // The reason jobs.origin exists. Neither surface spends anything
    // directly — the daemon does, on a queue both of them feed.
    const fromAgent = withOrigin('mcp', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'a' } }));
    const chained = withOrigin('mcp', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'b' } }));
    const fromCli = withOrigin('cli', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'c' } }));

    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.2, jobId: fromAgent.id });
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.3, jobId: chained.id });
    recordModelCall(db, { kind: 'role_research', model: 'haiku', costUsd: 0.05, jobId: fromCli.id });

    const report = buildSurfaceUsage(db, EPOCH);
    const mcp = report.surfaces.find((s) => s.surface === 'mcp')!;
    const cli = report.surfaces.find((s) => s.surface === 'cli')!;

    expect(mcp.spendUsd).toBeCloseTo(0.5, 6);
    expect(mcp.modelCalls).toBe(2);
    expect(cli.spendUsd).toBeCloseTo(0.05, 6);
    expect(report.unattributedSpendUsd).toBe(0);
  });

  it('admits spend it cannot attribute instead of absorbing it', () => {
    // Work the daemon starts for itself, and jobs predating the origin
    // column. A total that quietly swallows unknowns is worse than one that
    // admits them, since the point is choosing which surface to keep using.
    const daemonJob = withOrigin('daemon', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'd' } }));
    const legacy = withOrigin('cli', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'e' } }));
    db.prepare('UPDATE jobs SET origin = NULL WHERE id = ?').run(legacy.id);

    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.4, jobId: daemonJob.id });
    // A job with no recorded origin stays unattributed — it must not pick up
    // the origin of whichever process happens to be running the call.
    withOrigin('cli', () => recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.1, jobId: legacy.id }));

    const report = buildSurfaceUsage(db, EPOCH);
    expect(report.unattributedSpendUsd).toBeCloseTo(0.5, 6);
    expect(report.unattributedModelCalls).toBe(2);
    expect(report.surfaces.every((surface) => surface.spendUsd === 0)).toBe(true);
  });

  it('attributes a call with no job behind it to the process that made it', () => {
    // Nothing routes that way today — every extraction carries a job — but
    // the column is nullable, and a direct call from a surface really is
    // caused by that surface.
    withOrigin('mcp', () => recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.25 }));

    const report = buildSurfaceUsage(db, EPOCH);
    expect(report.surfaces.find((s) => s.surface === 'mcp')!.spendUsd).toBeCloseTo(0.25, 6);
    expect(report.unattributedSpendUsd).toBe(0);
  });

  it('keeps its attribution after the job it came from is gone', () => {
    // The reason the origin is on the ledger row rather than joined: the
    // foreign key is ON DELETE SET NULL, so pruning completed jobs used to
    // move historical spend into "unattributed" and silently rewrite the
    // answer to "is the agent worth it".
    const job = withOrigin('mcp', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'f' } }));
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.6, jobId: job.id });

    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);

    const report = buildSurfaceUsage(db, EPOCH);
    expect(report.surfaces.find((s) => s.surface === 'mcp')!.spendUsd).toBeCloseTo(0.6, 6);
    expect(report.unattributedSpendUsd).toBe(0);
  });

  it('reports process startup apart from the work itself', () => {
    // Measured, not assumed: driving both surfaces showed `cm roles list`
    // doing 5 ms of work while costing a third of a second, against ~1 ms
    // for the same request over a long-lived MCP server. Reporting only
    // in-process time concluded the two were near-identical, which is the
    // opposite of what actually happens.
    invocation('cli', 5, 'succeeded', 300);
    invocation('cli', 7, 'succeeded', 340);
    invocation('mcp', 1);

    const report = buildSurfaceUsage(db, EPOCH);
    expect(report.surfaces.find((s) => s.surface === 'cli')!.medianStartupMs).toBe(300);
    // Nothing records it for the MCP surface, and inventing a zero would
    // read as "measured and free" rather than "not applicable".
    expect(report.surfaces.find((s) => s.surface === 'mcp')!.medianStartupMs).toBeNull();
  });

  it('never folds startup into the work duration', () => {
    invocation('cli', 5, 'succeeded', 300);

    const cli = buildSurfaceUsage(db, EPOCH).surfaces.find((s) => s.surface === 'cli')!;
    // The two answer different questions — slow work versus an expensive
    // surface shape — and adding them would hide which one you have.
    expect(cli.medianMs).toBe(5);
    expect(cli.medianStartupMs).toBe(300);
  });

  it('survives a context that is missing, malformed, or holds something else', () => {
    invocation('cli', 5);
    recordOperationalLog(db, { outcome: 'succeeded', component: 'cli', action: 'x', durationMs: 6, context: { other: 1 } });
    db.prepare("INSERT INTO operational_logs (severity, outcome, component, action, duration_ms, context) VALUES ('info','succeeded','cli','x',7,'{oops')").run();

    const cli = buildSurfaceUsage(db, EPOCH).surfaces.find((s) => s.surface === 'cli')!;
    expect(cli.calls).toBe(3);
    expect(cli.medianStartupMs).toBeNull();
  });

  it('accounts for every dollar the ledger holds', () => {
    // The invariant that makes this block trustworthy: surfaces plus
    // unattributed must equal the total `cm status` reports on the line
    // below it. Any row the join quietly drops would show up as the two
    // numbers disagreeing, and nothing else would notice.
    const fromCli = withOrigin('cli', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'a' } }));
    const fromAgent = withOrigin('mcp', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'b' } }));
    const fromDaemon = withOrigin('daemon', () => enqueueJob(db, { topic: 'enrichment', payload: { kind: 'c' } }));

    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.11, jobId: fromCli.id });
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.22, jobId: fromAgent.id });
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.33, jobId: fromDaemon.id });
    recordModelCall(db, { kind: 'role_research', model: 'sonnet', costUsd: 0.44 });

    const report = buildSurfaceUsage(db, EPOCH);
    const accounted =
      report.surfaces.reduce((sum, surface) => sum + surface.spendUsd, 0) + report.unattributedSpendUsd;
    const accountedCalls =
      report.surfaces.reduce((sum, surface) => sum + surface.modelCalls, 0) + report.unattributedModelCalls;

    const total = spendSince(db, EPOCH);
    expect(accounted).toBeCloseTo(total.totalUsd, 6);
    expect(accountedCalls).toBe(total.calls);
  });

  it('reports a surface that has never been used as empty, not as missing', () => {
    // `cm status` prints the comparison; a surface vanishing from it would
    // read as "no data yet" and as "not installed" identically.
    invocation('cli', 10);

    const report = buildSurfaceUsage(db, EPOCH);
    expect(report.surfaces.map((s) => s.surface)).toEqual(['cli', 'mcp']);
    expect(report.surfaces.find((s) => s.surface === 'mcp')).toMatchObject({
      calls: 0,
      medianMs: null,
      p90Ms: null,
      medianStartupMs: null,
      spendUsd: 0,
    });
  });

  it('ignores anything outside the window', () => {
    invocation('cli', 10);
    db.prepare("UPDATE operational_logs SET occurred_at = '1999-01-01T00:00:00.000Z'").run();

    expect(buildSurfaceUsage(db, EPOCH).surfaces.every((s) => s.calls === 0)).toBe(true);
  });

  it('counts only the surfaces a person drives', () => {
    // The daemon's own components are work, not a way of asking for work —
    // including them would make the comparison meaningless.
    recordOperationalLog(db, { outcome: 'succeeded', component: 'enrichment', action: 'x', durationMs: 5000 });
    recordOperationalLog(db, { outcome: 'succeeded', component: 'job-queue', action: 'enqueue', durationMs: 1 });

    expect(buildSurfaceUsage(db, EPOCH).surfaces.every((s) => s.calls === 0)).toBe(true);
  });
});
