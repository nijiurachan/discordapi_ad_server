import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { MessageComponentInteractionPayload } from '../../../src/discord/types.ts';
import type { Bindings } from '../../../src/env.ts';
import { handleReviewRejectButton } from '../../../src/interactions/buttons/review-reject-button.ts';

const REVIEWER_ROLE_ID = 'role-reviewer';

function buildPayload(overrides?: {
  customId?: string;
  roles?: string[];
}): MessageComponentInteractionPayload {
  return {
    type: 3,
    id: 'int-1',
    application_id: 'app-1',
    guild_id: 'guild-1',
    channel_id: 'review-chan',
    member: {
      user: { id: 'reviewer-1', username: 'reviewer' },
      roles: overrides?.roles ?? [REVIEWER_ROLE_ID],
    },
    data: {
      custom_id: overrides?.customId ?? 'review:reject:ad-123',
      component_type: 2,
    },
    message: { id: 'msg-1', channel_id: 'review-chan' },
  };
}

function buildEnv(): Bindings {
  // Only REVIEWER_ROLE_ID is consulted by this handler — the rest are stubs
  // so the type checker is satisfied.
  return {
    DISCORD_APP_ID: 'app',
    DISCORD_APP_BOT_ID: 'bot',
    DISCORD_PUBLIC_KEY: 'pub',
    DISCORD_BOT_TOKEN: 'tok',
    GUILD_ID: 'guild',
    SUBMIT_CHANNEL_ID: 'submit',
    REVIEW_CHANNEL_ID: 'review-chan',
    ADMIN_CHANNEL_ID: 'admin',
    FALLBACK_CHANNEL_CATEGORY_ID: 'cat',
    REVIEWER_ROLE_ID,
    ADMIN_ROLE_ID: 'admin-role',
    POSTGRES_URL: 'postgres://x',
    S3_ENDPOINT: 'https://s3',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
    IP_HASH_SALT_BOOTSTRAP: 'salt',
    WORKER_BASE_URL: 'https://worker.example',
  };
}

async function invoke(payload: MessageComponentInteractionPayload): Promise<Response> {
  const app = new Hono<{ Bindings: Bindings }>();
  const env = buildEnv();
  app.post('/', (c) => handleReviewRejectButton(c, payload));
  return app.request('http://test/', { method: 'POST' }, env);
}

describe('handleReviewRejectButton', () => {
  it('returns Modal response with reason TEXT_INPUT (paragraph, 10–500 chars)', async () => {
    const res = await invoke(buildPayload());
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      type: number;
      data: {
        custom_id: string;
        title: string;
        components: Array<{
          type: number;
          components: Array<{
            type: number;
            custom_id: string;
            style: number;
            required?: boolean;
            min_length?: number;
            max_length?: number;
          }>;
        }>;
      };
    };
    // type 9 = MODAL
    expect(json.type).toBe(9);
    expect(json.data.custom_id).toBe('review-reject-modal:ad-123');
    expect(json.data.title).toContain('却下理由');
    // One ACTION_ROW with one TEXT_INPUT.
    expect(json.data.components).toHaveLength(1);
    const row = json.data.components[0];
    if (!row) throw new Error('action row missing');
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(1);
    const input = row.components[0];
    if (!input) throw new Error('text input missing');
    expect(input.type).toBe(4);
    expect(input.custom_id).toBe('reason');
    // PARAGRAPH style + required + length bounds.
    expect(input.style).toBe(2);
    expect(input.required).toBe(true);
    expect(input.min_length).toBe(10);
    expect(input.max_length).toBe(500);
  });

  it('returns ephemeral permission error when member lacks reviewer role', async () => {
    const res = await invoke(buildPayload({ roles: ['some-other-role'] }));
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('レビュアー権限');
  });

  it('returns ephemeral permission error when roles array is missing entirely', async () => {
    const payload = buildPayload();
    // Force the no-roles case: drop the roles field.
    payload.member = { user: { id: 'reviewer-1' } };
    const res = await invoke(payload);
    const json = (await res.json()) as { type: number; data: { content: string } };
    expect(json.type).toBe(4);
    expect(json.data.content).toContain('レビュアー権限');
  });

  it('returns ephemeral when custom_id has no adId segment', async () => {
    const res = await invoke(buildPayload({ customId: 'review:reject:' }));
    const json = (await res.json()) as { type: number; data: { content: string; flags: number } };
    expect(json.type).toBe(4);
    expect(json.data.flags).toBe(64);
    expect(json.data.content).toContain('広告 ID');
  });
});
