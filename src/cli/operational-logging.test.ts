import { describe, expect, it } from 'vitest';
import { startupCostMs } from './operational-logging.js';

describe('startupCostMs', () => {
  it('measures only what happened before the action, not the action itself', () => {
    // The arithmetic the whole CLI-vs-agent comparison turns on. Returning
    // raw `process.uptime()` would silently fold the command's own duration
    // into the startup figure, and every other test would still pass — which
    // is the exact "quietly stopped working" class CLAUDE.md warns about.
    const uptimeMs = process.uptime() * 1000;
    const began = Date.now() - 50;

    const startup = startupCostMs(began);

    expect(startup).not.toBeNull();
    // 50 ms of that uptime belongs to the action, so startup must be below
    // uptime by roughly that much.
    expect(startup!).toBeLessThan(uptimeMs - 40);
    expect(startup!).toBeGreaterThan(0);
  });

  it('clamps rather than reporting a negative startup', () => {
    // Reachable when the action appears to have begun before the process
    // did — a wall clock stepped forward by NTP or a laptop resuming from
    // sleep, neither of which moves `process.uptime()`.
    expect(startupCostMs(Date.now() - 60 * 60 * 1000)).toBe(0);
  });

  it('reports nothing when the action was never timed', () => {
    expect(startupCostMs(undefined)).toBeNull();
  });
});
