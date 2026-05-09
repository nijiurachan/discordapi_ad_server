import { describe, expect, it } from 'vitest';
import type { FormatRules } from '../../src/validation/rules.ts';
import { validateBody, validateLinkUrl, validateTitle } from '../../src/validation/text.ts';

function buildRules(overrides: Partial<FormatRules> = {}): FormatRules {
  return {
    slot: 'default',
    allowedMimes: ['image/png'],
    allowedExtensions: ['png'],
    maxBytes: 1_000_000,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    aspectRatios: null,
    aspectTolerance: 0.02,
    titleMaxLen: 80,
    bodyMaxLen: 500,
    linkUrlMaxLen: 2048,
    linkScheme: ['https'],
    linkDomainAllowlist: null,
    linkDomainBlocklist: null,
    ...overrides,
  };
}

describe('validateTitle', () => {
  it('rejects empty title', () => {
    const r = validateTitle(buildRules(), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('タイトルを入力');
  });

  it('rejects oversized title', () => {
    const r = validateTitle(buildRules({ titleMaxLen: 5 }), 'abcdef');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('上限');
  });

  it('accepts valid title', () => {
    const r = validateTitle(buildRules(), 'hello');
    expect(r.ok).toBe(true);
  });
});

describe('validateBody', () => {
  it('rejects empty body', () => {
    const r = validateBody(buildRules(), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('本文を入力');
  });

  it('rejects oversized body', () => {
    const r = validateBody(buildRules({ bodyMaxLen: 3 }), 'abcd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('上限');
  });

  it('accepts valid body', () => {
    const r = validateBody(buildRules(), 'short body');
    expect(r.ok).toBe(true);
  });
});

describe('validateLinkUrl', () => {
  it('rejects empty url', () => {
    const r = validateLinkUrl(buildRules(), '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('リンク URL を入力');
  });

  it('rejects oversized url', () => {
    const r = validateLinkUrl(buildRules({ linkUrlMaxLen: 10 }), 'https://example.com/path');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('上限');
  });

  it('rejects malformed url', () => {
    const r = validateLinkUrl(buildRules(), 'not-a-url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不正');
  });

  it('rejects disallowed scheme', () => {
    const r = validateLinkUrl(buildRules(), 'http://example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('スキーム');
  });

  it('accepts allowlist exact match', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainAllowlist: ['example.com'] }),
      'https://example.com/x',
    );
    expect(r.ok).toBe(true);
  });

  it('accepts allowlist subdomain match', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainAllowlist: ['example.com'] }),
      'https://blog.example.com/x',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects allowlist miss', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainAllowlist: ['example.com'] }),
      'https://other.org/x',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('許可リスト');
  });

  it('rejects blocklist hit (exact)', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainBlocklist: ['bad.com'] }),
      'https://bad.com/x',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ブロック');
  });

  it('rejects blocklist hit (subdomain)', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainBlocklist: ['bad.com'] }),
      'https://sub.bad.com/x',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ブロック');
  });

  it('passes blocklist miss', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainBlocklist: ['bad.com'] }),
      'https://good.com/x',
    );
    expect(r.ok).toBe(true);
  });

  it('hostname comparison is case-insensitive', () => {
    const r = validateLinkUrl(
      buildRules({ linkDomainAllowlist: ['Example.COM'] }),
      'https://EXAMPLE.com/x',
    );
    expect(r.ok).toBe(true);
  });
});
