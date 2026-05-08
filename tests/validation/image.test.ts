import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/discord/types.ts';
import { validateImage, validateMagicBytes } from '../../src/validation/image.ts';
import type { FormatRules } from '../../src/validation/rules.ts';

const baseRules: FormatRules = {
  slot: 'default',
  allowedMimes: ['image/png', 'image/jpeg'],
  allowedExtensions: ['png', 'jpg', 'jpeg'],
  maxBytes: 1_000_000,
  minWidth: 200,
  maxWidth: 2000,
  minHeight: 200,
  maxHeight: 2000,
  aspectRatios: ['1:1', '16:9'],
  aspectTolerance: 0.02,
  titleMaxLen: 80,
  bodyMaxLen: 500,
  linkUrlMaxLen: 2048,
  linkScheme: ['https'],
  linkDomainAllowlist: null,
  linkDomainBlocklist: null,
};

const validAttachment: Attachment = {
  id: 'a1',
  url: 'https://cdn.discordapp.com/attachments/1/2/foo.png?ex=abc',
  filename: 'foo.png',
  content_type: 'image/png',
  size: 500_000,
  width: 800,
  height: 800,
};

describe('validateImage', () => {
  it('returns ok when MIME, ext, size, dims and aspect are all in range', () => {
    const result = validateImage(baseRules, validAttachment);
    expect(result.ok).toBe(true);
  });

  it('errors when MIME is not allowed', () => {
    const result = validateImage(baseRules, {
      ...validAttachment,
      content_type: 'image/bmp',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('MIME'))).toBe(true);
    }
  });

  it('errors when extension is not allowed', () => {
    const result = validateImage(baseRules, {
      ...validAttachment,
      url: 'https://cdn.discordapp.com/attachments/1/2/foo.bmp',
      filename: 'foo.bmp',
      content_type: 'image/png', // keep mime ok to isolate ext error
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('拡張子'))).toBe(true);
    }
  });

  it('errors when size exceeds maxBytes', () => {
    const result = validateImage(baseRules, {
      ...validAttachment,
      size: 2_000_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('画像サイズ'))).toBe(true);
    }
  });

  it('errors when width is below min', () => {
    const result = validateImage(baseRules, {
      ...validAttachment,
      width: 100,
      height: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('画像幅が最小値未満'))).toBe(true);
    }
  });

  it('errors when aspect ratio is outside tolerance', () => {
    // 4:3 is far from both 1:1 and 16:9
    const result = validateImage(baseRules, {
      ...validAttachment,
      width: 1200,
      height: 900,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('アスペクト比'))).toBe(true);
    }
  });

  it('strips query strings from URL when extracting extension', () => {
    const result = validateImage(baseRules, {
      ...validAttachment,
      url: 'https://example.com/foo.png?signed=xyz&t=123',
      filename: 'foo.png',
    });
    expect(result.ok).toBe(true);
  });

  it('skips invalid aspect ratio entries gracefully', () => {
    // First entry "1:invalid" is malformed (NaN denominator). The validator
    // must not pass it as a match — only the well-formed "16:9" entry should
    // count. A 16:9 attachment under this rule set should still validate ok.
    const rules: FormatRules = {
      ...baseRules,
      aspectRatios: ['1:invalid', '16:9'],
      aspectTolerance: 0.02,
    };
    const result = validateImage(rules, {
      ...validAttachment,
      width: 1600,
      height: 900,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when only malformed aspect ratio entries are present', () => {
    const rules: FormatRules = {
      ...baseRules,
      aspectRatios: ['1:invalid', 'bogus'],
      aspectTolerance: 0.02,
    };
    const result = validateImage(rules, {
      ...validAttachment,
      width: 1600,
      height: 900,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes('アスペクト比'))).toBe(true);
    }
  });
});

describe('validateMagicBytes', () => {
  it('identifies PNG', () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(validateMagicBytes(buf)).toBe('image/png');
  });

  it('identifies JPEG', () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(validateMagicBytes(buf)).toBe('image/jpeg');
  });

  it('identifies GIF87a', () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00, 0x00]);
    expect(validateMagicBytes(buf)).toBe('image/gif');
  });

  it('identifies GIF89a', () => {
    const buf = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    expect(validateMagicBytes(buf)).toBe('image/gif');
  });

  it('identifies WebP', () => {
    const buf = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      0x00,
      0x00,
      0x00,
      0x00, // size (any)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
      0x00,
      0x00,
    ]);
    expect(validateMagicBytes(buf)).toBe('image/webp');
  });

  it('returns null for arbitrary garbage', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]);
    expect(validateMagicBytes(buf)).toBeNull();
  });

  it('returns null for empty buffer', () => {
    expect(validateMagicBytes(new Uint8Array())).toBeNull();
  });

  it('returns null for RIFF without WEBP marker', () => {
    const buf = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x00,
    ]);
    expect(validateMagicBytes(buf)).toBeNull();
  });
});
