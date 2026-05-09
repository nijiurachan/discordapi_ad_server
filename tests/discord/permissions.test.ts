import { describe, expect, it } from 'vitest';
import {
  PERM_ALLOW_BOT,
  PERM_ALLOW_SPONSOR,
  PERM_DENY_EVERYONE,
  PermissionBit,
  buildFallbackOverwrites,
} from '../../src/discord/permissions.ts';

describe('PermissionBit constants', () => {
  it('matches Discord permission bit specification', () => {
    expect(PermissionBit.VIEW_CHANNEL).toBe(0x400n);
    expect(PermissionBit.SEND_MESSAGES).toBe(0x800n);
    expect(PermissionBit.MANAGE_MESSAGES).toBe(0x4000n);
    expect(PermissionBit.READ_MESSAGE_HISTORY).toBe(0x10000n);
  });

  it('numeric string constants match expected values', () => {
    expect(PERM_DENY_EVERYONE).toBe('1024');
    expect(PERM_ALLOW_SPONSOR).toBe('66560');
    expect(PERM_ALLOW_BOT).toBe('84992');
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
      allow: '84992',
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
