import { describe, expect, it } from 'vitest';
import { AdminButtonIds, buildAdminMenuMessage } from '../../src/discord/admin-menu.ts';

describe('buildAdminMenuMessage', () => {
  const menu = buildAdminMenuMessage();

  it('has a single embed with the admin console title', () => {
    expect(menu.embeds).toHaveLength(1);
    const first = menu.embeds[0];
    expect(first).toBeDefined();
    expect(first?.title).toContain('広告管理コンソール');
  });

  it('has 4 action rows', () => {
    expect(menu.components).toHaveLength(4);
    for (const row of menu.components) {
      expect(row.type).toBe(1);
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });

  it('contains all 16 admin button custom_ids without duplicates', () => {
    const ids = menu.components
      .flatMap((row) => row.components)
      .map((b) => ('custom_id' in b ? b.custom_id : null))
      .filter((v): v is string => v !== null);
    expect(ids).toHaveLength(16);
    expect(new Set(ids).size).toBe(16);
    for (const id of Object.values(AdminButtonIds)) {
      expect(ids).toContain(id);
    }
  });

  it('all button custom_ids start with adm: prefix and stay within Discord 100-char limit', () => {
    const ids = Object.values(AdminButtonIds);
    for (const id of ids) {
      expect(id.startsWith('adm:')).toBe(true);
      expect(id.length).toBeLessThanOrEqual(100);
    }
  });
});
