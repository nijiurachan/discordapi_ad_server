export const PermissionBit = {
  VIEW_CHANNEL: 0x400n, // 1024
  SEND_MESSAGES: 0x800n, // 2048
  MANAGE_MESSAGES: 0x2000n, // 8192
  READ_MESSAGE_HISTORY: 0x10000n, // 65536
} as const;

export const PERM_DENY_EVERYONE = PermissionBit.VIEW_CHANNEL.toString(); // '1024'

export const PERM_ALLOW_SPONSOR = (
  PermissionBit.VIEW_CHANNEL | PermissionBit.READ_MESSAGE_HISTORY
).toString(); // '66560'

export const PERM_ALLOW_BOT = (
  PermissionBit.VIEW_CHANNEL |
  PermissionBit.SEND_MESSAGES |
  PermissionBit.READ_MESSAGE_HISTORY |
  PermissionBit.MANAGE_MESSAGES
).toString(); // '76800'

export type PermissionOverwrite = {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow?: string;
  deny?: string;
};

export function buildFallbackOverwrites(args: {
  guildId: string;
  sponsorId: string;
  botId: string;
}): PermissionOverwrite[] {
  return [
    { id: args.guildId, type: 0, deny: PERM_DENY_EVERYONE },
    { id: args.sponsorId, type: 1, allow: PERM_ALLOW_SPONSOR },
    { id: args.botId, type: 1, allow: PERM_ALLOW_BOT },
  ];
}
