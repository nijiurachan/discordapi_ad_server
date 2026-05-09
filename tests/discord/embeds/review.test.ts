import { describe, expect, it } from 'vitest';
import {
  buildReviewButtons,
  buildReviewEmbed,
  buildReviewOutcomeEmbed,
} from '../../../src/discord/embeds/review.ts';

type EmbedShape = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  image?: { url: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
};

function asEmbed(value: Record<string, unknown>): EmbedShape {
  return value as unknown as EmbedShape;
}

describe('buildReviewEmbed', () => {
  it('builds an embed with title, url, fields, and image', () => {
    const embed = asEmbed(
      buildReviewEmbed(
        {
          id: 'ad-1',
          slot: 'default',
          title: 'My Ad',
          body: 'Body text',
          linkUrl: 'https://example.com',
          imageUrl: 'https://worker.example/images/ads/ad-1/orig.png',
        },
        { id: 'user-1' },
      ),
    );
    expect(embed.title).toBe('📥 新しい広告審査依頼');
    expect(embed.url).toBe('https://example.com');
    expect(embed.description).toBe('**My Ad**');
    expect(embed.color).toBe(0x3498db);
    expect(embed.image).toEqual({ url: 'https://worker.example/images/ads/ad-1/orig.png' });
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === 'スポンサー')?.value).toBe('<@user-1>');
    expect(fields.find((f) => f.name === '広告 ID')?.value).toBe('`ad-1`');
    expect(fields.find((f) => f.name === 'スロット')?.value).toBe('default');
  });

  it('omits the image property when imageUrl is not provided', () => {
    const embed = asEmbed(
      buildReviewEmbed(
        {
          id: 'ad-2',
          slot: 'default',
          title: 'No Image',
          body: 'b',
          linkUrl: 'https://example.com',
        },
        { id: 'user-2' },
      ),
    );
    expect(embed.image).toBeUndefined();
  });

  it('truncates body and linkUrl fields to 1024 chars', () => {
    const longBody = 'b'.repeat(2000);
    const longUrl = `https://example.com/${'a'.repeat(2000)}`;
    const embed = asEmbed(
      buildReviewEmbed(
        {
          id: 'ad-3',
          slot: 'default',
          title: 'T',
          body: longBody,
          linkUrl: longUrl,
        },
        { id: 'user-3' },
      ),
    );
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === '本文')?.value.length).toBe(1024);
    expect(fields.find((f) => f.name === 'リンク URL')?.value.length).toBe(1024);
    // embed.url retains the full URL.
    expect(embed.url).toBe(longUrl);
  });
});

describe('buildReviewOutcomeEmbed', () => {
  it('builds an approved embed (green, ✅)', () => {
    const embed = asEmbed(
      buildReviewOutcomeEmbed(
        { id: 'ad-1', slot: 'default', title: 'T', body: 'b', linkUrl: 'https://example.com' },
        { id: 'user-1' },
        'approved',
        'reviewer-1',
      ),
    );
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.title).toContain('✅');
    expect(embed.title).toContain('承認済');
    expect(embed.title).toContain('<@reviewer-1>');
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === 'レビュアー')?.value).toBe('<@reviewer-1>');
    expect(fields.find((f) => f.name === '理由')).toBeUndefined();
  });

  it('builds a rejected embed (red, ❌) with reason', () => {
    const embed = asEmbed(
      buildReviewOutcomeEmbed(
        { id: 'ad-2', slot: 'default', title: 'T', body: 'b', linkUrl: 'https://example.com' },
        { id: 'user-2' },
        'rejected',
        'reviewer-2',
        'spam content',
      ),
    );
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.title).toContain('❌');
    expect(embed.title).toContain('却下');
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === '理由')?.value).toBe('spam content');
  });

  it('builds a withdrawn embed (grey, ↩)', () => {
    const embed = asEmbed(
      buildReviewOutcomeEmbed(
        { id: 'ad-3', slot: 'default', title: 'T', body: 'b', linkUrl: 'https://example.com' },
        { id: 'user-3' },
        'withdrawn',
        'reviewer-3',
      ),
    );
    expect(embed.color).toBe(0x95a5a6);
    expect(embed.title).toContain('↩');
    expect(embed.title).toContain('取り下げ');
  });

  it('truncates reason to 1024 chars', () => {
    const longReason = 'r'.repeat(2000);
    const embed = asEmbed(
      buildReviewOutcomeEmbed(
        { id: 'ad-4', slot: 'default', title: 'T', body: 'b', linkUrl: 'https://example.com' },
        { id: 'user-4' },
        'rejected',
        'reviewer-4',
        longReason,
      ),
    );
    const fields = embed.fields ?? [];
    expect(fields.find((f) => f.name === '理由')?.value.length).toBe(1024);
  });

  it('includes image when imageUrl is provided', () => {
    const embed = asEmbed(
      buildReviewOutcomeEmbed(
        {
          id: 'ad-5',
          slot: 'default',
          title: 'T',
          body: 'b',
          linkUrl: 'https://example.com',
          imageUrl: 'https://worker.example/images/ads/ad-5/orig.png',
        },
        { id: 'user-5' },
        'approved',
        'reviewer-5',
      ),
    );
    expect(embed.image).toEqual({ url: 'https://worker.example/images/ads/ad-5/orig.png' });
  });
});

describe('buildReviewButtons', () => {
  it('produces an action row with approve (success) and reject (danger) buttons', () => {
    const row = buildReviewButtons('ad-uuid-123');
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(2);
    const approve = row.components[0];
    const reject = row.components[1];
    if (!approve || !reject) throw new Error('expected two buttons');
    if (approve.style === 5 || reject.style === 5) {
      throw new Error('expected interactive buttons, got LINK style');
    }
    expect(approve.style).toBe(3); // SUCCESS
    expect(approve.custom_id).toBe('review:approve:ad-uuid-123');
    expect(approve.label).toBe('✅ 承認');
    expect(reject.style).toBe(4); // DANGER
    expect(reject.custom_id).toBe('review:reject:ad-uuid-123');
    expect(reject.label).toBe('❌ 却下');
  });
});
