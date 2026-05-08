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
