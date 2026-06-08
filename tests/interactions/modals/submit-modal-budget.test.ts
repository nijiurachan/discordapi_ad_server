import type { S3Client } from '@aws-sdk/client-s3';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from '../../../src/db/client.ts';
import type { DiscordRest } from '../../../src/discord/rest.ts';
import type { ModalSubmitInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import {
  type ModalSubmitDeps,
  runSubmitModal,
} from '../../../src/interactions/modals/submit-modal.ts';

type CapturedCall = { sql: string; params: unknown[] | undefined };

function mockClient(
  responses: Array<{ rows: unknown[]; rowCount?: number }>,
  captured: CapturedCall[] = [],
): PgClient {
  let i = 0;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const r = responses[i++];
      if (!r) return { rows: [], rowCount: 0 };
      return { rowCount: r.rowCount ?? r.rows.length, ...r };
    }) as unknown as PgClient['query'],
    end: vi.fn(async () => undefined),
  };
}

function mockRest(): DiscordRest {
  return {
    createMessage: vi.fn(async () => ({ id: 'msg-1', channel_id: 'review-chan' })),
  } as unknown as DiscordRest;
}

function mockS3(): S3Client {
  // copyObject() streams source bytes via GET then PUT (workerd has no DOMParser
  // for the SDK's CopyObject XML). The GetObject response therefore needs a Body;
  // every other command resolves to an empty result.
  return {
    send: vi.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') {
        return {
          Body: new Response(new Uint8Array([1, 2, 3])).body,
          ContentType: 'image/png',
        };
      }
      return {};
    }),
  } as unknown as S3Client;
}

const FUTURE = new Date(Date.now() + 5 * 60 * 1000);

// draftRow now carries `weight` (the reserved alloc).
function draftRow(weight: number | null) {
  return {
    id: 'draft-1',
    sponsor_id: 'user-1',
    slot: 'default',
    image_key: 'staging/draft-1/orig.png',
    image_mime: 'image/png',
    image_bytes: 100_000,
    image_width: 800,
    image_height: 800,
    weight,
    expires_at: FUTURE,
  };
}

const formatRulesRow = {
  slot: 'default',
  allowedMimes: ['image/png'],
  allowedExtensions: ['png'],
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

function buildPayload(): ModalSubmitInteractionPayload {
  return {
    type: 5,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    member: { user: { id: 'user-1', username: 'sponsor-display' } },
    data: {
      custom_id: 'submit:draft-1',
      components: [
        { type: 1, components: [{ type: 4, custom_id: 'title', value: 'My Ad' }] },
        { type: 1, components: [{ type: 4, custom_id: 'body', value: 'Hello world' }] },
        {
          type: 1,
          components: [{ type: 4, custom_id: 'link_url', value: 'https://example.com/promo' }],
        },
      ],
    },
  };
}

async function invoke(
  payload: ModalSubmitInteractionPayload,
  deps: ModalSubmitDeps,
): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  app.post('/', (c) => runSubmitModal(c, payload, deps));
  return app.request('http://test/', { method: 'POST' });
}

function defaultDeps(client: PgClient): ModalSubmitDeps {
  return {
    rest: mockRest(),
    client,
    s3: mockS3(),
    bucket: 'test-bucket',
    reviewChannelId: 'review-chan',
    s3PublicBaseUrl: 'https://cdn.example',
    uuid: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
}

describe('runSubmitModal budget gate (atomic conditional INSERT)', () => {
  it('rejects with budget message when the conditional INSERT affects 0 rows', async () => {
    const captured: CapturedCall[] = [];
    // fetchDraft, fetchFormatRules, BEGIN, SELECT id, conditional INSERT(0 rows), ROLLBACK
    const client = mockClient(
      [
        { rows: [draftRow(30)] }, // fetchDraft (reserved weight 30)
        { rows: [formatRulesRow] }, // fetchFormatRules
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
        { rows: [], rowCount: 0 }, // conditional INSERT INTO ads -> over budget
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('予算');
    // The INSERT was the conditional form and the draft was NOT deleted.
    const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
    expect(insert?.sql).toMatch(/COALESCE\(SUM\(weight_alloc\), 0\)/);
    expect(insert?.sql).toMatch(/status IN \('pending', 'approved'\)/);
    expect(captured.every((c) => !/DELETE FROM ad_drafts/.test(c.sql))).toBe(true);
    expect(captured.every((c) => !/^COMMIT$/.test(c.sql.trim()))).toBe(true);
  });

  it('inserts the pending ad with weight_alloc = draft.weight when within budget', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [draftRow(20)] }, // fetchDraft
        { rows: [formatRulesRow] }, // fetchFormatRules
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id
        { rows: [], rowCount: 1 }, // conditional INSERT -> 1 row
        { rows: [] }, // DELETE ad_drafts
        { rows: [] }, // COMMIT
        { rows: [] }, // UPDATE review_message_id
      ],
      captured,
    );
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('受付完了');
    const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
    expect(insert).toBeDefined();
    // requested weight (20) is bound as a param (alloc reservation) and as the
    // SUM addend in the WHERE clause; assert it's present and the sponsor + ad id are too.
    expect(insert?.params).toContain(20);
    expect(insert?.params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(insert?.params).toContain('user-1');
    // draft cleared + committed.
    expect(captured.some((c) => /DELETE FROM ad_drafts/.test(c.sql))).toBe(true);
    expect(captured.some((c) => /^COMMIT$/.test(c.sql.trim()))).toBe(true);
  });

  it('defaults the reservation to 1 when draft.weight is null', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [draftRow(null)] },
        { rows: [formatRulesRow] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id
        { rows: [], rowCount: 1 }, // INSERT
        { rows: [] }, // DELETE
        { rows: [] }, // COMMIT
        { rows: [] }, // UPDATE review_message_id
      ],
      captured,
    );
    await invoke(buildPayload(), defaultDeps(client));
    const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
    expect(insert?.params).toContain(1);
  });
});
