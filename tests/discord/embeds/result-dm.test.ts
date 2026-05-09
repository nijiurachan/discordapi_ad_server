import { describe, expect, it } from 'vitest';
import {
  type ResultDmAdInfo,
  buildApproveDmEmbed,
  buildRejectDmEmbed,
} from '../../../src/discord/embeds/result-dm.ts';

type EmbedField = { name: string; value: string; inline?: boolean };
type EmbedShape = {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text?: string };
  timestamp?: string;
};

function asEmbed(value: Record<string, unknown>): EmbedShape {
  return value as unknown as EmbedShape;
}

const baseAd: ResultDmAdInfo = {
  id: 'ad-1',
  slot: 'default',
  title: 'My Ad',
};

describe('buildApproveDmEmbed', () => {
  it('builds an approve embed with title, color, and fields including weight', () => {
    const embed = asEmbed(
      buildApproveDmEmbed({
        ...baseAd,
        weightSnapshot: 7,
        startsAt: new Date('2025-01-01T00:00:00Z'),
      }),
    );
    expect(embed.title).toBe('✅ 広告が承認されました');
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.description).toBe('**My Ad**');
    const fieldNames = (embed.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(['スロット', '広告 ID', '配信開始', '重み (weight)']),
    );
    const weight = (embed.fields ?? []).find((f) => f.name === '重み (weight)');
    expect(weight?.value).toBe('7');
    const adIdField = (embed.fields ?? []).find((f) => f.name === '広告 ID');
    expect(adIdField?.value).toBe('`ad-1`');
    expect(embed.footer?.text).toContain('広告起稿');
    expect(embed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('renders weight "—" when weightSnapshot is null', () => {
    const embed = asEmbed(buildApproveDmEmbed({ ...baseAd, weightSnapshot: null }));
    const weight = (embed.fields ?? []).find((f) => f.name === '重み (weight)');
    expect(weight?.value).toBe('—');
  });
});

describe('buildRejectDmEmbed', () => {
  it('builds a reject embed with red color, fields, and blockquoted reason', () => {
    const embed = asEmbed(
      buildRejectDmEmbed(
        { ...baseAd, reviewedAt: new Date('2025-01-02T00:00:00Z') },
        '規約に違反しています。',
      ),
    );
    expect(embed.title).toBe('❌ 広告が却下されました');
    expect(embed.color).toBe(0xe74c3c);
    const fieldNames = (embed.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(['スロット', '広告 ID', '却下日時', '却下理由']),
    );
    const reason = (embed.fields ?? []).find((f) => f.name === '却下理由');
    expect(reason?.value.startsWith('> ')).toBe(true);
    expect(reason?.value).toContain('規約に違反しています。');
  });

  it('truncates reason to 1000 chars', () => {
    const long = 'あ'.repeat(1500);
    const embed = asEmbed(buildRejectDmEmbed(baseAd, long));
    const reason = (embed.fields ?? []).find((f) => f.name === '却下理由');
    // value = '> ' + reason.slice(0, 1000)
    expect(reason?.value.length).toBe(2 + 1000);
    expect(reason?.value.startsWith('> ')).toBe(true);
  });
});
