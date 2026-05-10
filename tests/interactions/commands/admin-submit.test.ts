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
import {
  type AdminSubmitDeps,
  runAdminSubmit,
} from '../../../src/interactions/commands/admin-submit.ts';

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const ADMIN_ROLE = 'admin-role-id';

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

function mockS3(): S3Client {
  return { send: vi.fn(async () => ({})) } as unknown as S3Client;
}

function mockFetchOk(body: Uint8Array): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
}

function buildAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-admin',
    url: 'https://cdn.discordapp.com/attachments/1/2/banner.png',
    filename: 'banner.png',
    content_type: 'image/png',
    size: 500_000,
    width: 800,
    height: 800,
    ...overrides,
  };
}

const formatRulesRow = {
  slot: 'default',
  allowedMimes: ['image/png', 'image/jpeg'],
  allowedExtensions: ['png', 'jpg'],
  maxBytes: 1_000_000,
  minWidth: 200,
  maxWidth: 2000,
  minHeight: 200,
  maxHeight: 2000,
  aspectRatios: ['1:1'],
  aspectTolerance: '0.020',
  titleMaxLen: 80,
  bodyMaxLen: 500,
  linkUrlMaxLen: 2048,
  linkScheme: ['https'],
  linkDomainAllowlist: null,
  linkDomainBlocklist: null,
};

type BuildPayloadOpts = {
  kind?: string;
  slot?: string;
  weight?: number;
  sponsorId?: string;
  autoApprove?: boolean;
  endsInDays?: number;
  attachment?: Attachment;
  roles?: string[];
};

function buildPayload(opts: BuildPayloadOpts = {}): ApplicationCommandInteractionPayload {
  const attachment = opts.attachment ?? buildAttachment();
  const subOptions: Array<{
    name: string;
    type: number;
    value: string | number | boolean;
  }> = [
    { name: 'kind', type: 3, value: opts.kind ?? 'regular' },
    { name: 'slot', type: 3, value: opts.slot ?? 'default' },
    { name: 'image', type: 11, value: attachment.id },
  ];
  if (opts.weight !== undefined) subOptions.push({ name: 'weight', type: 4, value: opts.weight });
  if (opts.sponsorId !== undefined)
    subOptions.push({ name: 'sponsor_id', type: 3, value: opts.sponsorId });
  if (opts.autoApprove !== undefined)
    subOptions.push({ name: 'auto_approve', type: 5, value: opts.autoApprove });
  if (opts.endsInDays !== undefined)
    subOptions.push({ name: 'ends_in_days', type: 4, value: opts.endsInDays });

  return {
    type: 2,
    id: 'int-admin',
    application_id: 'app',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    member: {
      user: { id: 'admin-user', username: 'AdminUser' },
      roles: opts.roles ?? [ADMIN_ROLE],
    },
    data: {
      id: 'cmd-admin',
      name: 'admin',
      type: 1,
      options: [{ name: 'submit', type: 1, options: subOptions }],
      resolved: { attachments: { [attachment.id]: attachment } },
    },
  };
}

function makeDeps(opts: { client: PgClient }): AdminSubmitDeps {
  return {
    client: opts.client,
    rest: {} as DiscordRest,
    s3: mockS3(),
    bucket: 'test-bucket',
    adminRoleId: ADMIN_ROLE,
    fetchImpl: mockFetchOk(PNG_HEADER),
    uuid: () => 'draft-fixed',
  };
}

async function invoke(
  payload: ApplicationCommandInteractionPayload,
  deps: AdminSubmitDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runAdminSubmit(c, payload, deps));
  return app.request('http://t/', { method: 'POST', body: '{}' });
}

describe('runAdminSubmit', () => {
  it('rejects non-admin members with ephemeral', async () => {
    const client = mockClient([]);
    const deps = makeDeps({ client });
    const res = await invoke(buildPayload({ roles: [] }), deps);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('管理者');
  });

  it('rejects kind=house with sponsor_id specified', async () => {
    const client = mockClient([]);
    const deps = makeDeps({ client });
    const res = await invoke(buildPayload({ kind: 'house', sponsorId: 'sponsor-x' }), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.data.content).toContain('sponsor_id');
  });

  it('happy path: kind=regular returns Modal and persists draft', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [formatRulesRow] }, // fetchFormatRules
        { rows: [] }, // sponsors UPSERT
        { rows: [] }, // ad_drafts INSERT
      ],
      captured,
    );
    const deps = makeDeps({ client });
    const res = await invoke(buildPayload({ kind: 'regular', autoApprove: true }), deps);
    const json = (await res.json()) as {
      type: number;
      data: { custom_id: string };
    };
    expect(json.type).toBe(9); // MODAL
    expect(json.data.custom_id).toBe('admin-submit:draft-fixed');
    const insertCall = captured.find((q) => q.sql.includes('INSERT INTO ad_drafts'));
    expect(insertCall).toBeDefined();
    // Params include kind, weight, auto_approve, ends_in_days, created_by_admin
    const params = insertCall?.params ?? [];
    expect(params).toContain('regular');
    expect(params).toContain(true); // auto_approve
    expect(params).toContain('admin-user'); // created_by_admin
  });

  it('returns ephemeral when image attachment is missing', async () => {
    const client = mockClient([]);
    const deps = makeDeps({ client });
    const payload = buildPayload();
    payload.data.resolved = { attachments: {} };
    const res = await invoke(payload, deps);
    const json = (await res.json()) as { data: { content: string } };
    expect(json.data.content).toContain('添付');
  });
});
