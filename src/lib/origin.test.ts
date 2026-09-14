import { describe, expect, it } from 'vitest';
import { getOrigin, setProcessOrigin, toOrigin, withOrigin } from './origin.js';

describe('origin', () => {
  it('defaults to the cli, which is what an unmarked entry point is', () => {
    expect(getOrigin()).toBe('cli');
  });

  it('keeps concurrent async work from stealing each other\'s origin', async () => {
    // The reason this is AsyncLocalStorage and not a module-level variable:
    // the worker pool runs several drainSlot loops through Promise.all, and
    // a plain global set around `await handler(job)` would be overwritten by
    // whichever slot interleaved — making every number this step reports
    // quietly wrong.
    const seen: string[] = [];
    const slot = (origin: 'mcp' | 'daemon', delay: number) =>
      withOrigin(origin, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(`${origin}:${getOrigin()}`);
      });

    await Promise.all([slot('mcp', 20), slot('daemon', 5)]);

    expect(seen.sort()).toEqual(['daemon:daemon', 'mcp:mcp']);
  });

  it('restores the process origin once the scope ends', () => {
    setProcessOrigin('daemon');
    try {
      expect(withOrigin('mcp', () => getOrigin())).toBe('mcp');
      expect(getOrigin()).toBe('daemon');
    } finally {
      setProcessOrigin('cli');
    }
  });

  it('refuses a value that is not one of the surfaces', () => {
    // Rows predate the column, and a hand-edited database can hold anything.
    expect(toOrigin('mcp')).toBe('mcp');
    expect(toOrigin(null)).toBeUndefined();
    expect(toOrigin('agent')).toBeUndefined();
    expect(toOrigin(7)).toBeUndefined();
  });
});
