import { describe, expect, it } from 'vitest';
import { inferJobEntity } from './job-entity.js';

describe('inferJobEntity', () => {
  it('prefers an explicit entityType/entityId pair when present', () => {
    expect(inferJobEntity({ entityType: 'role', entityId: 5, roleId: 999 })).toEqual({
      entityType: 'role',
      entityId: 5,
    });
  });

  it('falls back to roleId', () => {
    expect(inferJobEntity({ kind: 'role-structural', roleId: 7 })).toEqual({ entityType: 'role', entityId: 7 });
  });

  it('falls back to companyId', () => {
    expect(inferJobEntity({ kind: 'company-structural', companyId: 3 })).toEqual({
      entityType: 'company',
      entityId: 3,
    });
  });

  it('returns undefined for a payload with no correlatable id', () => {
    expect(inferJobEntity({ kind: 'echo' })).toBeUndefined();
    expect(inferJobEntity({})).toBeUndefined();
    expect(inferJobEntity(null)).toBeUndefined();
    expect(inferJobEntity('not an object')).toBeUndefined();
  });

  it('ignores a null entityId (notification payloads allow one) and falls back correctly', () => {
    expect(inferJobEntity({ entityType: 'role', entityId: null, roleId: 12 })).toEqual({
      entityType: 'role',
      entityId: 12,
    });
  });

  it('ignores an invalid entityType string', () => {
    expect(inferJobEntity({ entityType: 'bogus', entityId: 1 })).toBeUndefined();
  });
});
