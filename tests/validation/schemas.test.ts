import { describe, expect, it } from 'vitest';
import { parseAdFormatRules } from '../../src/validation/schemas.ts';

const valid = {
  slot: 'default',
  allowedMimes: ['image/png', 'image/jpeg'],
  allowedExtensions: ['png', 'jpg'],
  maxBytes: 1_000_000,
  titleMaxLen: 80,
  bodyMaxLen: 500,
  linkUrlMaxLen: 2048,
  linkScheme: ['https'],
};

describe('parseAdFormatRules', () => {
  it('accepts a minimal valid object', () => {
    const result = parseAdFormatRules(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects unsupported MIME types', () => {
    const result = parseAdFormatRules({ ...valid, allowedMimes: ['image/avif'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('allowedMimes');
    }
  });

  it('rejects negative maxBytes', () => {
    const result = parseAdFormatRules({ ...valid, maxBytes: -1 });
    expect(result.ok).toBe(false);
  });

  it('applies defaults for linkScheme when omitted', () => {
    const { linkScheme, ...rest } = valid;
    const result = parseAdFormatRules(rest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.linkScheme).toEqual(['https']);
  });

  it('rejects malformed aspectRatios entries', () => {
    const result = parseAdFormatRules({ ...valid, aspectRatios: ['abc'] });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty allowedExtensions array', () => {
    const result = parseAdFormatRules({ ...valid, allowedExtensions: [] });
    expect(result.ok).toBe(false);
  });
});
