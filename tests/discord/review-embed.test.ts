import { describe, expect, it, vi } from 'vitest';
import type { DiscordRest } from '../../src/discord/rest.ts';
import { postReviewEmbed } from '../../src/discord/review-embed.ts';

type CreateMessageCall = [
  channelId: string,
  body: {
    embeds: Array<Record<string, unknown>>;
    components: Array<{ type: number; components: Array<{ custom_id?: string; style: number }> }>;
  },
];

describe('postReviewEmbed', () => {
  it('posts an embed with the correct image URL and field shape, plus action-row buttons, and returns the message id', async () => {
    const createMessage = vi.fn(async (_channelId: string, _body: Record<string, unknown>) => ({
      id: 'msg-1',
      channel_id: 'review-chan',
    }));
    const rest = { createMessage } as unknown as DiscordRest;

    const result = await postReviewEmbed({
      rest,
      channelId: 'review-chan',
      workerBaseUrl: 'https://worker.example',
      ad: {
        id: 'ad-uuid',
        slot: 'default',
        title: 'My Ad',
        body: 'Body text',
        linkUrl: 'https://example.com',
        imageExt: 'png',
      },
      sponsor: { id: 'user-123' },
    });

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(createMessage).toHaveBeenCalledTimes(1);
    const call = createMessage.mock.calls[0] as unknown as CreateMessageCall;
    expect(call[0]).toBe('review-chan');
    expect(call[1].embeds).toHaveLength(1);
    const embed = call[1].embeds[0] as {
      url: string;
      image: { url: string };
      fields: Array<{ name: string; value: string }>;
      description: string;
    };
    expect(embed.url).toBe('https://example.com');
    expect(embed.image.url).toBe('https://worker.example/images/ads/ad-uuid/orig.png');
    const sponsorField = embed.fields.find((f) => f.name === 'スポンサー');
    expect(sponsorField?.value).toBe('<@user-123>');
    const idField = embed.fields.find((f) => f.name === '広告 ID');
    expect(idField?.value).toContain('ad-uuid');

    // Action-row with two interactive buttons.
    expect(call[1].components).toHaveLength(1);
    const row = call[1].components[0];
    if (!row) throw new Error('expected one action row');
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(2);
    const approve = row.components[0];
    const reject = row.components[1];
    if (!approve || !reject) throw new Error('expected two buttons');
    expect(approve.custom_id).toBe('review:approve:ad-uuid');
    expect(approve.style).toBe(3); // SUCCESS
    expect(reject.custom_id).toBe('review:reject:ad-uuid');
    expect(reject.style).toBe(4); // DANGER
  });

  it('truncates linkUrl field to 1024 chars but keeps full URL on embed.url', async () => {
    const createMessage = vi.fn(async (_channelId: string, _body: Record<string, unknown>) => ({
      id: 'msg-1',
      channel_id: 'review-chan',
    }));
    const rest = { createMessage } as unknown as DiscordRest;

    // 1100-char URL: longer than the 1024 field cap.
    const longLinkUrl = `https://example.com/${'a'.repeat(1100 - 'https://example.com/'.length)}`;
    expect(longLinkUrl.length).toBeGreaterThan(1024);

    await postReviewEmbed({
      rest,
      channelId: 'review-chan',
      workerBaseUrl: 'https://worker.example',
      ad: {
        id: 'ad-1',
        slot: 'default',
        title: 'T',
        body: 'b',
        linkUrl: longLinkUrl,
        imageExt: 'png',
      },
      sponsor: { id: 'user-1' },
    });

    const call = createMessage.mock.calls[0] as unknown as CreateMessageCall;
    const embed = call[1].embeds[0] as {
      url: string;
      fields: Array<{ name: string; value: string }>;
    };
    // Field value is truncated to 1024.
    const linkField = embed.fields.find((f) => f.name === 'リンク URL');
    expect(linkField?.value.length).toBe(1024);
    // embed.url retains the full untruncated URL so the embed clickthrough
    // still resolves to the intended target.
    expect(embed.url).toBe(longLinkUrl);
  });

  it('truncates body field to 1024 chars', async () => {
    const createMessage = vi.fn(async (_channelId: string, _body: Record<string, unknown>) => ({
      id: 'msg-1',
      channel_id: 'review-chan',
    }));
    const rest = { createMessage } as unknown as DiscordRest;

    const longBody = 'x'.repeat(2000);
    await postReviewEmbed({
      rest,
      channelId: 'review-chan',
      workerBaseUrl: 'https://worker.example',
      ad: {
        id: 'ad-1',
        slot: 'default',
        title: 'T',
        body: longBody,
        linkUrl: 'https://example.com',
        imageExt: 'jpg',
      },
      sponsor: { id: 'user-1' },
    });

    const call = createMessage.mock.calls[0] as unknown as CreateMessageCall;
    const embed = call[1].embeds[0] as {
      fields: Array<{ name: string; value: string }>;
    };
    const bodyField = embed.fields.find((f) => f.name === '本文');
    expect(bodyField?.value.length).toBe(1024);
  });
});
