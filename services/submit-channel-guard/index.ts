/**
 * submit-channel-guard
 *
 * Tiny long-running Discord gateway client that policies the submit channel:
 * every non-bot MESSAGE_CREATE in SUBMIT_CHANNEL_ID is silently deleted. No
 * warning is posted — ephemeral messages aren't available outside of
 * interactions, and a public reply would just clutter the channel.
 *
 * The main Discord bot for this project runs on Cloudflare Workers (HTTP
 * interactions only — no gateway). That can't receive MESSAGE_CREATE, so this
 * small daemon fills the gap. Reuses the same DISCORD_BOT_TOKEN.
 *
 * Run under systemd (services/submit-channel-guard/submit-channel-guard.service).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, type Message } from 'discord.js';

/**
 * Hand-rolled .dev.vars loader: the file uses shell-style `KEY="value"` lines
 * which systemd's EnvironmentFile would pass through with the quotes intact.
 * Strip them here and skip blank / comment lines.
 */
function loadDevVars(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch (err) {
    console.warn(`could not read ${envPath}:`, (err as Error).message);
    return;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadDevVars(resolve(here, '../../.dev.vars'));

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SUBMIT_CHANNEL = process.env.SUBMIT_CHANNEL_ID;

if (!TOKEN || !SUBMIT_CHANNEL) {
  console.error('DISCORD_BOT_TOKEN and SUBMIT_CHANNEL_ID are required');
  process.exit(1);
}

const client = new Client({
  // We only need to know channel membership and read message metadata. Reading
  // the body would need MessageContent (privileged); we don't, since the
  // policy is "delete every non-bot message" regardless of content.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (c) => {
  console.log(
    `submit-channel-guard ready as ${c.user.tag} (id=${c.user.id}); watching channel=${SUBMIT_CHANNEL}`,
  );
});

async function handleMessage(message: Message): Promise<void> {
  if (message.channelId !== SUBMIT_CHANNEL) return;
  if (message.author.bot) return;
  // System messages (join notices, etc.) have system=true — let Discord
  // manage those itself; deleting them is normally not allowed anyway.
  if (message.system) return;

  try {
    await message.delete();
    console.log(
      `deleted message id=${message.id} author=${message.author.id} (${message.author.username})`,
    );
  } catch (err) {
    console.warn('delete failed', { id: message.id, err: (err as Error).message });
  }
}

client.on(Events.MessageCreate, (message) => {
  handleMessage(message as Message).catch((err) => {
    console.error('handler crashed', err);
  });
});

client.on(Events.Error, (err) => {
  console.error('client error', err);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM — shutting down');
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT — shutting down');
  client.destroy();
  process.exit(0);
});

await client.login(TOKEN);
