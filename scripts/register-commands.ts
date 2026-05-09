// Usage: tsx scripts/register-commands.ts
//
// Registers slash commands to a guild via Discord REST API.
// Required env vars must be exported in the shell or sourced from .dev.vars
// before running (this script does not load any .env file itself).

import process from 'node:process';

const { DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_APP_ID || !DISCORD_BOT_TOKEN || !GUILD_ID) {
  console.error('DISCORD_APP_ID, DISCORD_BOT_TOKEN, GUILD_ID are required');
  process.exit(1);
}

const commands = [
  {
    name: 'ping',
    description: 'liveness check (P1 placeholder)',
    type: 1,
  },
  {
    name: 'ad',
    description: 'Ad management commands',
    type: 1,
    options: [
      {
        name: 'submit',
        description: 'Submit a new ad for review',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'slot',
            description: 'Slot the ad will be displayed in',
            type: 3, // STRING
            required: true,
            choices: [{ name: 'default', value: 'default' }],
          },
          {
            name: 'image',
            description: 'Banner image (PNG/JPEG/GIF/WebP)',
            type: 11, // ATTACHMENT
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: 'ad-setup',
    description: '常設メニューを指定チャンネルに投稿',
    type: 1,
    default_member_permissions: '8', // ADMINISTRATOR (1 << 3)
    options: [
      {
        name: 'channel',
        description: 'メニューを投稿するチャンネル',
        type: 7, // CHANNEL
        required: true,
      },
      {
        name: 'kind',
        description: 'メニューの種類',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'submit', value: 'submit' },
          { name: 'review', value: 'review' },
          { name: 'admin', value: 'admin' },
        ],
      },
    ],
  },
];

const url = `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${GUILD_ID}/commands`;
const res = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error('register failed:', res.status, await res.text());
  process.exit(1);
}

console.log('registered:', await res.json());
