import { describe, expect, it } from 'vitest';
import { isAdmin } from '../../src/discord/admin-auth.ts';

describe('isAdmin', () => {
  it('returns true when member.roles contains adminRoleId', () => {
    expect(isAdmin({ member: { roles: ['100', '200'] } }, '200')).toBe(true);
  });

  it('returns false when member.roles does not contain adminRoleId', () => {
    expect(isAdmin({ member: { roles: ['100', '300'] } }, '200')).toBe(false);
  });

  it('returns false when member is missing', () => {
    expect(isAdmin({}, '200')).toBe(false);
  });

  it('returns false when adminRoleId is empty string (misconfiguration safety)', () => {
    expect(isAdmin({ member: { roles: ['100', ''] } }, '')).toBe(false);
  });
});
