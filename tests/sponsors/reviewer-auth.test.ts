import { describe, expect, it } from 'vitest';
import { isReviewer } from '../../src/sponsors/reviewer-auth.ts';

describe('isReviewer', () => {
  it('returns false when member is missing or roles are absent', () => {
    expect(isReviewer({}, 'role-1')).toBe(false);
    expect(isReviewer({ member: {} }, 'role-1')).toBe(false);
    expect(isReviewer({ member: { roles: [] } }, 'role-1')).toBe(false);
  });

  it('returns true when reviewer role is present', () => {
    expect(isReviewer({ member: { roles: ['role-1', 'role-2'] } }, 'role-1')).toBe(true);
  });

  it('returns false when reviewer role is absent', () => {
    expect(isReviewer({ member: { roles: ['role-2', 'role-3'] } }, 'role-1')).toBe(false);
  });
});
