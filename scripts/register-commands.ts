// Usage: npm run discord:register
//
// Registers slash commands to a guild via Discord REST API.
// Env vars are loaded from .dev.vars by the npm script's `dotenv -e .dev.vars`
// wrapper. Direct `tsx scripts/register-commands.ts` invocation requires the
// vars to be exported in the shell.

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
      {
        name: 'list',
        description: '自分の広告一覧を表示',
        type: 1,
      },
      {
        name: 'withdraw',
        description: '自分の広告を取り下げる',
        type: 1,
        options: [
          {
            name: 'id',
            description: '広告 ID',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'stats',
        description: '自分の広告の統計を表示',
        type: 1,
        options: [
          {
            name: 'period',
            description: '集計期間',
            type: 3, // STRING
            required: false,
            choices: [
              { name: '24h', value: '24h' },
              { name: '7d', value: '7d' },
              { name: '30d', value: '30d' },
              { name: 'all', value: 'all' },
            ],
          },
        ],
      },
      {
        name: 'rules',
        description: '入稿ルールを表示',
        type: 1,
      },
    ],
  },
  {
    name: 'admin',
    description: '管理者向けコマンド',
    type: 1,
    default_member_permissions: '8', // ADMINISTRATOR
    options: [
      {
        name: 'stats',
        description: '全広告の統計（impression/click/CTR）を集計',
        type: 1,
        options: [
          {
            name: 'period',
            description: '集計期間',
            type: 3,
            required: false,
            choices: [
              { name: '24h', value: '24h' },
              { name: '7d', value: '7d' },
              { name: '30d', value: '30d' },
              { name: '90d', value: '90d' },
              { name: 'all', value: 'all' },
            ],
          },
          {
            name: 'top_n',
            description: '上位 N 件 (1-1000、規定: 50)',
            type: 4,
            required: false,
            min_value: 1,
            max_value: 1000,
          },
          {
            name: 'csv',
            description: 'CSV 出力（署名付き URL）',
            type: 5,
            required: false,
          },
        ],
      },
      {
        name: 'replace-image',
        description: '広告の画像を差し替える',
        type: 1,
        options: [
          {
            name: 'ad_id',
            description: '対象広告 ID',
            type: 3,
            required: true,
          },
          {
            name: 'image',
            description: '新しいバナー画像',
            type: 11,
            required: true,
          },
        ],
      },
      {
        name: 'submit',
        description: '管理者として広告を投入（Tier/Fallback チェックをスキップ）',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'kind',
            description: '広告種別',
            type: 3, // STRING
            required: true,
            choices: [
              { name: 'regular', value: 'regular' },
              { name: 'house', value: 'house' },
              { name: 'placeholder', value: 'placeholder' },
            ],
          },
          {
            name: 'slot',
            description: 'スロット',
            type: 3,
            required: true,
            choices: [{ name: 'default', value: 'default' }],
          },
          {
            name: 'image',
            description: 'バナー画像',
            type: 11, // ATTACHMENT
            required: true,
          },
          {
            name: 'weight',
            description: '重み（1-1000、規定: kind依存）',
            type: 4, // INTEGER
            required: false,
            min_value: 1,
            max_value: 1000,
          },
          {
            name: 'sponsor_id',
            description: 'sponsor の Discord User ID（regular のみ）',
            type: 3, // STRING
            required: false,
          },
          {
            name: 'auto_approve',
            description: 'true なら status=approved で即時開始',
            type: 5, // BOOLEAN
            required: false,
          },
          {
            name: 'ends_in_days',
            description: '配信終了までの日数（1-365、未指定で無期限）',
            type: 4,
            required: false,
            min_value: 1,
            max_value: 365,
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
