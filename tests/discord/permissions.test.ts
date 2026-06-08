import { describe, expect, it } from 'vitest';
import {
  PERM_ALLOW_BOT,
  PERM_ALLOW_SPONSOR,
  PERM_DENY_EVERYONE,
  PermissionBit,
  buildFallbackOverwrites,
  buildPortalOverwrites,
} from '../../src/discord/permissions.ts';

describe('PermissionBit constants', () => {
  it('matches Discord permission bit specification', () => {
    expect(PermissionBit.VIEW_CHANNEL).toBe(0x400n);
    expect(PermissionBit.SEND_MESSAGES).toBe(0x800n);
    expect(PermissionBit.MANAGE_MESSAGES).toBe(0x2000n);
    expect(PermissionBit.READ_MESSAGE_HISTORY).toBe(0x10000n);
  });

  it('numeric string constants match expected values', () => {
    expect(PERM_DENY_EVERYONE).toBe('1024');
    expect(PERM_ALLOW_SPONSOR).toBe('66560');
    expect(PERM_ALLOW_BOT).toBe('76800');
  });
});

describe('buildFallbackOverwrites', () => {
  it('returns 3-element array with correct shape (everyone deny / sponsor allow / bot allow)', () => {
    const overwrites = buildFallbackOverwrites({
      guildId: 'guild-1',
      sponsorId: 'sponsor-1',
      botId: 'bot-1',
    });

    expect(overwrites).toHaveLength(3);

    expect(overwrites[0]).toEqual({
      id: 'guild-1',
      type: 0,
      deny: '1024',
    });
    expect(overwrites[1]).toEqual({
      id: 'sponsor-1',
      type: 1,
      allow: '66560',
    });
    expect(overwrites[2]).toEqual({
      id: 'bot-1',
      type: 1,
      allow: '76800',
    });
  });

  it('uses the same string constants the module exports', () => {
    const overwrites = buildFallbackOverwrites({
      guildId: 'g',
      sponsorId: 's',
      botId: 'b',
    });
    expect(overwrites[0]?.deny).toBe(PERM_DENY_EVERYONE);
    expect(overwrites[1]?.allow).toBe(PERM_ALLOW_SPONSOR);
    expect(overwrites[2]?.allow).toBe(PERM_ALLOW_BOT);
  });
});

describe('buildPortalOverwrites', () => {
  it('denies @everyone and allows sponsor, bot, reviewer role, admin role', () => {
    const ow = buildPortalOverwrites({
      guildId: 'g',
      sponsorId: 's',
      botId: 'b',
      reviewerRoleId: 'rev',
      adminRoleId: 'adm',
    });
    expect(ow).toEqual([
      { id: 'g', type: 0, deny: '1024' },
      { id: 's', type: 1, allow: '66560' },
      { id: 'b', type: 1, allow: '76800' },
      { id: 'rev', type: 0, allow: '66560' },
      { id: 'adm', type: 0, allow: '66560' },
    ]);
  });

  it('dedupes staff roles equal to @everyone and skips empty ids', () => {
    const ow = buildPortalOverwrites({
      guildId: 'g',
      sponsorId: 's',
      botId: 'b',
      reviewerRoleId: '',
      adminRoleId: 'g',
    });
    expect(ow.map((o) => o.id)).toEqual(['g', 's', 'b']);
  });
});
