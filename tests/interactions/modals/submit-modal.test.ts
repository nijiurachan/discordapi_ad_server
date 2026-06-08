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

// --- helpers --------------------------------------------------------------

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

const FUTURE = new Date(Date.now() + 5 * 60 * 1000); // +5min
const PAST = new Date(Date.now() - 5 * 60 * 1000); // -5min

const draftRow = {
  id: 'draft-1',
  sponsor_id: 'user-1',
  slot: 'default',
  image_key: 'staging/draft-1/orig.png',
  image_mime: 'image/png',
  image_bytes: 100_000,
  image_width: 800,
  image_height: 800,
  weight: 1,
  expires_at: FUTURE,
};

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

function buildPayload(overrides?: {
  customId?: string;
  title?: string;
  body?: string;
  linkUrl?: string;
}): ModalSubmitInteractionPayload {
  return {
    type: 5,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'chan-1',
    member: { user: { id: 'user-1', username: 'sponsor-display' } },
    data: {
      custom_id: overrides?.customId ?? 'submit:draft-1',
      components: [
        {
          type: 1,
          components: [{ type: 4, custom_id: 'title', value: overrides?.title ?? 'My Ad' }],
        },
        {
          type: 1,
          components: [{ type: 4, custom_id: 'body', value: overrides?.body ?? 'Hello world' }],
        },
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: 'link_url',
              value: overrides?.linkUrl ?? 'https://example.com/promo',
            },
          ],
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

function defaultDeps(client: PgClient, rest = mockRest()): ModalSubmitDeps {
  return {
    rest,
    client,
    s3: mockS3(),
    bucket: 'test-bucket',
    reviewChannelId: 'review-chan',
    s3PublicBaseUrl: 'https://cdn.example',
    uuid: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  };
}

// --- tests ----------------------------------------------------------------

describe('runSubmitModal', () => {
  it('happy path: returns ephemeral confirmation, inserts ads row, and persists review_message_id', async () => {
    const captured: CapturedCall[] = [];
    // Tx-aware query order:
    //   1) fetchDraft
    //   2) fetchFormatRules
    //   3) BEGIN
    //   4) SELECT id FROM ad_drafts  (must return draft row)
    //   5) conditional INSERT ads (budget guard) -> rowCount 1
    //   6) DELETE ad_drafts
    //   7) COMMIT
    //   8) UPDATE ads SET review_message_id (after best-effort embed post)
    const client = mockClient(
      [
        { rows: [draftRow] },
        { rows: [formatRulesRow] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
        { rows: [], rowCount: 1 }, // conditional INSERT -> 1 row
        { rows: [] }, // DELETE
        { rows: [] }, // COMMIT
        { rows: [] }, // UPDATE review_message_id
      ],
      captured,
    );
    const rest = mockRest();
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('受付完了');
    expect(json.data.content).toContain('審査結果');

    // Transaction control statements ran in order.
    expect(captured.some((c) => /^BEGIN$/.test(c.sql.trim()))).toBe(true);
    expect(captured.some((c) => /SELECT id FROM ad_drafts/i.test(c.sql))).toBe(true);
    expect(captured.some((c) => /^COMMIT$/.test(c.sql.trim()))).toBe(true);

    const insert = captured.find((c) => /INSERT INTO ads/.test(c.sql));
    expect(insert).toBeDefined();
    // ad_id (param 1), sponsor (param 2), slot (param 3)
    expect(insert?.params?.[0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(insert?.params?.[1]).toBe('user-1');
    expect(insert?.params?.[2]).toBe('default');
    // image_key uses ads/{ad_id}/orig.png — index 6 (0-indexed: id, sponsor, slot, title, body, link, image_key)
    expect(insert?.params?.[6]).toBe('ads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/orig.png');

    const del = captured.find((c) => /DELETE FROM ad_drafts/.test(c.sql));
    expect(del).toBeDefined();
    expect(del?.params).toEqual(['draft-1']);

    expect(rest.createMessage).toHaveBeenCalledWith(
      'review-chan',
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );

    // review_message_id was persisted from the createMessage response (msg-1).
    const updateMsgId = captured.find((c) => /UPDATE ads SET review_message_id/.test(c.sql));
    expect(updateMsgId).toBeDefined();
    expect(updateMsgId?.params).toEqual(['msg-1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']);
  });

  it('rejects malformed custom_id (no submit: prefix)', async () => {
    const client = mockClient([]);
    const res = await invoke(buildPayload({ customId: 'other:abc' }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('不正な custom_id');
  });

  it('returns ephemeral when draft not found', async () => {
    const client = mockClient([{ rows: [] }]);
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('下書きが見つかりません');
  });

  it('returns ephemeral when draft is expired', async () => {
    const client = mockClient([{ rows: [{ ...draftRow, expires_at: PAST }] }]);
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('有効期限');
  });

  it('returns ephemeral when format rules missing', async () => {
    const client = mockClient([{ rows: [draftRow] }, { rows: [] }]);
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('入稿ルール');
  });

  it('returns ephemeral on title validation failure', async () => {
    const client = mockClient([{ rows: [draftRow] }, { rows: [formatRulesRow] }]);
    const res = await invoke(buildPayload({ title: '' }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('タイトル');
  });

  it('returns ephemeral on link URL validation failure (bad scheme)', async () => {
    const client = mockClient([{ rows: [draftRow] }, { rows: [formatRulesRow] }]);
    const res = await invoke(buildPayload({ linkUrl: 'http://example.com' }), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('スキーム');
  });

  it('returns ephemeral when the conditional INSERT is over budget (race-condition guard)', async () => {
    const captured: CapturedCall[] = [];
    // Budget guard is the conditional INSERT itself:
    //   1) fetchDraft, 2) fetchFormatRules, 3) BEGIN,
    //   4) SELECT id, 5) conditional INSERT (rowCount 0), 6) ROLLBACK
    const client = mockClient(
      [
        { rows: [draftRow] },
        { rows: [formatRulesRow] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
        { rows: [], rowCount: 0 }, // conditional INSERT -> over budget
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    const res = await invoke(buildPayload(), defaultDeps(client));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('予算');

    // Transaction was rolled back — INSERT attempted but no COMMIT.
    expect(captured.some((c) => /^ROLLBACK$/.test(c.sql.trim()))).toBe(true);
    expect(captured.every((c) => !/^COMMIT$/.test(c.sql.trim()))).toBe(true);
    expect(captured.every((c) => !/DELETE FROM ad_drafts/.test(c.sql))).toBe(true);
  });

  it('rolls back and cleans up finalKey when the conditional INSERT is over budget', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [draftRow] },
        { rows: [formatRulesRow] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
        { rows: [], rowCount: 0 }, // conditional INSERT -> over budget
        { rows: [] }, // ROLLBACK
      ],
      captured,
    );
    // Track each S3 op so we can assert the cleanup DELETE happened on
    // the freshly-copied finalKey. copyObject() does GET (needs a Body) + PUT.
    const s3Calls: Array<{ kind: string; key: string }> = [];
    const s3 = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
        s3Calls.push({ kind: cmd.constructor.name, key: cmd.input.Key });
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: new Response(new Uint8Array([1, 2, 3])).body,
            ContentType: 'image/png',
          };
        }
        return {};
      }),
    } as unknown as S3Client;
    const deps: ModalSubmitDeps = { ...defaultDeps(client), s3 };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('予算');

    // ROLLBACK ran and no DELETE/COMMIT happened.
    expect(captured.some((c) => /^ROLLBACK$/.test(c.sql.trim()))).toBe(true);
    expect(captured.every((c) => !/^COMMIT$/.test(c.sql.trim()))).toBe(true);
    expect(captured.every((c) => !/DELETE FROM ad_drafts/.test(c.sql))).toBe(true);

    // S3: copy ads/.../orig.png happened (GET source + PUT dest), then cleanup
    // delete on the same key.
    const finalKey = 'ads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/orig.png';
    expect(s3Calls.some((c) => c.kind === 'PutObjectCommand' && c.key === finalKey)).toBe(true);
    expect(s3Calls.some((c) => c.kind === 'DeleteObjectCommand' && c.key === finalKey)).toBe(true);
  });

  it('still returns success even when review embed posting fails', async () => {
    const captured: CapturedCall[] = [];
    const client = mockClient(
      [
        { rows: [draftRow] },
        { rows: [formatRulesRow] },
        { rows: [] }, // BEGIN
        { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
        { rows: [], rowCount: 1 }, // conditional INSERT -> 1 row
        { rows: [] }, // DELETE
        { rows: [] }, // COMMIT
      ],
      captured,
    );
    const rest = {
      createMessage: vi.fn(async () => {
        throw new Error('discord 500');
      }),
    } as unknown as DiscordRest;
    const res = await invoke(buildPayload(), defaultDeps(client, rest));
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('受付完了');
    // When the embed post fails, review_message_id must NOT be updated.
    expect(captured.every((c) => !/UPDATE ads SET review_message_id/.test(c.sql))).toBe(true);
  });

  it('still returns success even when staging delete fails', async () => {
    const client = mockClient([
      { rows: [draftRow] },
      { rows: [formatRulesRow] },
      { rows: [] }, // BEGIN
      { rows: [{ id: 'draft-1' }] }, // SELECT id FROM ad_drafts
      { rows: [], rowCount: 1 }, // conditional INSERT -> 1 row
      { rows: [] }, // DELETE
      { rows: [] }, // COMMIT
      { rows: [] }, // UPDATE review_message_id
    ]);
    const s3 = {
      // copyObject() does GET (source, needs Body) + PUT (dest); the subsequent
      // staging DeleteObject throws to exercise the best-effort cleanup path.
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return {
            Body: new Response(new Uint8Array([1, 2, 3])).body,
            ContentType: 'image/png',
          };
        }
        if (cmd.constructor.name === 'DeleteObjectCommand') throw new Error('s3 down');
        return {};
      }),
    } as unknown as S3Client;
    const deps: ModalSubmitDeps = {
      ...defaultDeps(client),
      s3,
    };
    const res = await invoke(buildPayload(), deps);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('受付完了');
  });
});
