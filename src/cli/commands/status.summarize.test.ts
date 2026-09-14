import { describe, expect, it } from 'vitest';
import { summarizePayload } from './status.js';

describe('summarizePayload', () => {
  it('names the kind and the entity it acts on', () => {
    expect(summarizePayload(JSON.stringify({ kind: 'role-research', roleId: 7 }))).toBe('role-research roleId=7');
  });

  it('handles a payload with a kind but no entity', () => {
    expect(summarizePayload(JSON.stringify({ kind: 'discover' }))).toBe('discover');
  });

  it('says so when the payload has no kind at all', () => {
    // Notification payloads are shaped this way — a stranded notification
    // job is an ordinary thing to see here, not an edge case.
    expect(summarizePayload(JSON.stringify({ entityType: 'role', entityId: 7, message: 'closed' }))).toBe(
      '(no kind) entityId=7',
    );
  });

  it('never throws on a payload it cannot read', () => {
    // The column is plain text and this runs on the `cm status` read path,
    // so a hand-edited row must not take the whole digest down.
    expect(summarizePayload('{oops')).toBe('(unreadable payload)');
    expect(summarizePayload('null')).toBe('(unreadable payload)');
    expect(summarizePayload('[1,2]')).toBe('(no kind)');
  });
});
