import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type {
  ApplicationCommandInteractionPayload,
  Attachment,
  CommandOptionValue,
} from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import { type AdSubmitDeps, runAdSubmit } from '../../../src/interactions/commands/ad-submit.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows: unknown[] }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      return responses[i++] ?? { rows: [] };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

function mockRest(roles: string[] = ['role-bronze']): DiscordRest {
  return {
    getGuildMember: vi.fn(async () => ({
      user: { id: 'user-1', username: 'sponsor-display' },
      roles,
    })),
  } as unknown as DiscordRest;
}

function mockS3(): S3Client {
  return { send: vi.fn(async () => ({})) } as unknown as S3Client;
}

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function mockFetchOk(body: Uint8Array): typeof fetch {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
  );
}

function buildAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    url: 'https://cdn.discordapp.com/attachments/1/2/foo.png',
    filename: 'foo.png',
    content_type: 'image/png',
    size: 500_000,
    width: 800,
    height: 800,
    ...overrides,
  };
}

function buildPayload(weight?: number): ApplicationCommandInteractionPayload {
  const attachment = buildAttachment();
  const options: Array<{ name: string; type: number; value: CommandOptionValue }> = [
    { name: 'slot', type: 3, value: 'default' },
    { name: 'image', type: 11, value: attachment.id },
  ];
  if (weight !== undefined) options.push({ name: 'weight', type: 4, value: weight });
  return {
    type: 2,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    member: { user: { id: 'user-1', username: 'sponsor-display' }, roles: [] },
    data: {
      id: 'cmd-1',
      name: 'ad',
      type: 1,
      options: [{ name: 'submit', type: 1, options }],
      resolved: { attachments: { [attachment.id]: attachment } },
    },
  };
}

const tierRow = {
  id: 1,
  discordRoleId: 'role-bronze',
  name: 'Bronze',
  weight: 80,
  maxActiveAds: 80,
  rank: 10,
};

const formatRulesRow = {
  slot: 'default',
  allowedMimes: ['image/png', 'image/jpeg'],
  allowedExtensions: ['png', 'jpg', 'jpeg'],
  maxBytes: 1_000_000,
  minWidth: 200,
  maxWidth: 2000,
  minHeight: 200,
  maxHeight: 2000,
  aspectRatios: ['1:1'],
  aspectTolerance: 0.02,
  titleMaxLen: 80,
  bodyMaxLen: 500,
  linkUrlMaxLen: 2048,
  linkScheme: ['https'],
  linkDomainAllowlist: null,
  linkDomainBlocklist: null,
};

async function invoke(
  payload: ApplicationCommandInteractionPayload,
  deps: AdSubmitDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdSubmit(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

function deps(client: PgClient): AdSubmitDeps {
  return {
    client,
    rest: mockRest(['role-bronze']),
    s3: mockS3(),
    bucket: 'test-bucket',
    guildId: 'guild-1',
    fetchImpl: mockFetchOk(PNG_HEADER),
    uuid: () => '00000000-0000-0000-0000-000000000001',
  };
}

describe('runAdSubmit budget gate', () => {
  it('rejects when requested weight exceeds remaining budget', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // fallback gate
        { rows: [tierRow] }, // tiers (refreshSponsorTier)
        { rows: [] }, // upsert sponsors
        { rows: [{ weight: 80 }] }, // getSponsorBudget: tier JOIN
        { rows: [{ used: 80 }] }, // getSponsorBudget: sumActiveWeight => remaining 0
      ],
      captured,
    );
    const res = await invoke(buildPayload(1), deps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('予算');
    // Gate fired before format rules / draft insert.
    expect(captured.every((c) => !/INSERT INTO ad_drafts/.test(c.sql))).toBe(true);
  });

  it('passes the gate and stores weight_alloc intent (weight) in the draft when within budget', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // fallback gate
        { rows: [tierRow] }, // tiers
        { rows: [] }, // upsert sponsors
        { rows: [{ weight: 80 }] }, // getSponsorBudget: tier JOIN
        { rows: [{ used: 30 }] }, // getSponsorBudget: sumActiveWeight => remaining 50
        { rows: [formatRulesRow] }, // fetchFormatRules
        { rows: [] }, // INSERT ad_drafts
      ],
      captured,
    );
    const res = await invoke(buildPayload(20), deps(client));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number };
    expect(json.type).toBe(9); // Modal
    const insert = captured.find((c) => /INSERT INTO ad_drafts/.test(c.sql));
    expect(insert).toBeDefined();
    // weight is the 4th column/param (id, sponsor_id, slot, weight, ...).
    expect(insert?.params?.[3]).toBe(20);
  });

  it('defaults weight to 1 when the option is omitted', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [] }, // fallback gate
        { rows: [tierRow] }, // tiers
        { rows: [] }, // upsert sponsors
        { rows: [{ weight: 80 }] }, // tier JOIN
        { rows: [{ used: 0 }] }, // remaining 80
        { rows: [formatRulesRow] }, // rules
        { rows: [] }, // insert
      ],
      captured,
    );
    await invoke(buildPayload(), deps(client));
    const insert = captured.find((c) => /INSERT INTO ad_drafts/.test(c.sql));
    expect(insert?.params?.[3]).toBe(1);
  });
});
