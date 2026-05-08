import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type {
  ApplicationCommandInteractionPayload,
  Attachment,
} from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import { type AdSubmitDeps, runAdSubmit } from '../../../src/interactions/commands/ad-submit.ts';

// --- helpers --------------------------------------------------------------

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

const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00]);

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

function buildPayload(overrides?: {
  attachment?: Attachment;
  slot?: string;
}): ApplicationCommandInteractionPayload {
  const attachment = overrides?.attachment ?? buildAttachment();
  const slot = overrides?.slot ?? 'default';
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
      options: [
        {
          name: 'submit',
          type: 1,
          options: [
            { name: 'slot', type: 3, value: slot },
            { name: 'image', type: 11, value: attachment.id },
          ],
        },
      ],
      resolved: { attachments: { [attachment.id]: attachment } },
    },
  };
}

const tierRow = {
  id: 1,
  discordRoleId: 'role-bronze',
  name: 'Bronze',
  weight: 10,
  maxActiveAds: 2,
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

// We need a real Hono Context. Spin up a tiny Hono app per call: it routes
// to a single handler that invokes `runAdSubmit` with injected deps.
async function invoke(
  payload: ApplicationCommandInteractionPayload,
  deps: AdSubmitDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdSubmit(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

// --- tests ----------------------------------------------------------------

describe('runAdSubmit', () => {
  it('happy path: returns Modal response with custom_id starting submit:', async () => {
    const captured: CapturedCall[] = [];
    // 1) blockIfUnackedFallback SELECT (no rows)
    // 2) refreshSponsorTier SELECT tiers
    // 3) refreshSponsorTier UPSERT sponsors
    // 4) countActiveAds SELECT
    // 5) fetchFormatRules SELECT
    // 6) INSERT ad_drafts
    const client = mockClient(
      [
        { rows: [] }, // fallback gate
        { rows: [tierRow] }, // tiers
        { rows: [] }, // upsert sponsors
        { rows: [{ count: '0' }] }, // active count
        { rows: [formatRulesRow] }, // format rules
        { rows: [] }, // insert
      ],
      captured,
    );
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
      uuid: () => '00000000-0000-0000-0000-000000000001',
    };

    const res = await invoke(buildPayload(), deps);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type: number;
      data: { custom_id: string; title: string; components: unknown[] };
    };
    expect(json.type).toBe(9);
    expect(json.data.custom_id).toBe('submit:00000000-0000-0000-0000-000000000001');
    expect(json.data.components).toHaveLength(3);
    // Insert call params should mention the staging key with png ext
    const insertCall = captured.find((c) => /INSERT INTO ad_drafts/.test(c.sql));
    expect(insertCall).toBeDefined();
    expect(insertCall?.params?.[3]).toBe('staging/00000000-0000-0000-0000-000000000001/orig.png');
  });

  it('fallback-gate blocks: returns ephemeral with channel mention', async () => {
    const client = mockClient([
      {
        rows: [
          {
            id: 'fb-1',
            channel_id: 'chan-X',
            created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      },
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(buildPayload(), deps);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('<#chan-X>');
  });

  it('no-tier: returns ephemeral about tier role missing', async () => {
    const client = mockClient([
      { rows: [] }, // fallback gate
      { rows: [tierRow] }, // tiers (only role-bronze)
      { rows: [] }, // upsert
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-other']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('ティアロール');
  });

  it('over-limit: returns ephemeral with limit message', async () => {
    const client = mockClient([
      { rows: [] }, // fallback gate
      { rows: [tierRow] }, // tiers
      { rows: [] }, // upsert
      { rows: [{ count: '5' }] }, // active count > maxActiveAds (2)
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('Bronze');
  });

  it('missing format rules: returns ephemeral', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [tierRow] },
      { rows: [] },
      { rows: [{ count: '0' }] },
      { rows: [] }, // no format rules
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(buildPayload({ slot: 'unknown' }), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('入稿ルール');
  });

  it('image validation failure (size too big): returns ephemeral', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [tierRow] },
      { rows: [] },
      { rows: [{ count: '0' }] },
      { rows: [formatRulesRow] },
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(
      buildPayload({ attachment: buildAttachment({ size: 5_000_000 }) }),
      deps,
    );
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('画像サイズ');
  });

  it('magic-bytes mismatch (claims png, body is jpeg): returns ephemeral', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [tierRow] },
      { rows: [] },
      { rows: [{ count: '0' }] },
      { rows: [formatRulesRow] },
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      // attachment.content_type is image/png but bytes are JPEG header
      fetchImpl: mockFetchOk(JPEG_HEADER),
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('改ざん');
  });

  it('discord REST throws (e.g. 404): returns ephemeral about guild member', async () => {
    const client = mockClient([{ rows: [] } /* fallback gate */]);
    const rest = {
      getGuildMember: vi.fn(async () => {
        throw new Error('not found');
      }),
    } as unknown as DiscordRest;
    const deps: AdSubmitDeps = {
      client,
      rest,
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: mockFetchOk(PNG_HEADER),
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('ギルドメンバー');
  });

  it('image fetch fails (network): returns ephemeral about image fetch', async () => {
    const client = mockClient([
      { rows: [] },
      { rows: [tierRow] },
      { rows: [] },
      { rows: [{ count: '0' }] },
      { rows: [formatRulesRow] },
    ]);
    const deps: AdSubmitDeps = {
      client,
      rest: mockRest(['role-bronze']),
      s3: mockS3(),
      bucket: 'test-bucket',
      guildId: 'guild-1',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error('boom');
      }),
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('画像の取得');
  });
});
