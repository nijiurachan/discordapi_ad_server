import { describe, expect, it } from 'vitest';
import { shouldRecordEvent } from '../../src/utils/event-filter.ts';

describe('shouldRecordEvent', () => {
  it('returns false for HEAD method', () => {
    expect(shouldRecordEvent({ method: 'HEAD', ua: 'Mozilla/5.0' })).toBe(false);
  });

  it('returns false for HEAD method case-insensitively (lower)', () => {
    expect(shouldRecordEvent({ method: 'head', ua: 'Mozilla/5.0' })).toBe(false);
  });

  it('returns false for HEAD method case-insensitively (mixed)', () => {
    expect(shouldRecordEvent({ method: 'Head', ua: 'Mozilla/5.0' })).toBe(false);
  });

  it('returns true for GET with normal Chrome UA', () => {
    expect(
      shouldRecordEvent({
        method: 'GET',
        ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }),
    ).toBe(true);
  });

  it('returns true for GET with normal Firefox UA', () => {
    expect(
      shouldRecordEvent({
        method: 'GET',
        ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
      }),
    ).toBe(true);
  });

  it('returns false for UA containing "bot"', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: 'somebot/1.0' })).toBe(false);
  });

  it('returns false for "Googlebot/2.1"', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: 'Googlebot/2.1' })).toBe(false);
  });

  it('returns false for "crawler"', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: 'crawler' })).toBe(false);
  });

  it('returns false for "spider"', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: 'spider' })).toBe(false);
  });

  it('returns false for "preview-agent"', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: 'preview-agent' })).toBe(false);
  });

  it('returns true for empty UA', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: '' })).toBe(true);
  });

  it('returns true for null UA', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: null })).toBe(true);
  });

  it('returns true for undefined UA', () => {
    expect(shouldRecordEvent({ method: 'GET', ua: undefined })).toBe(true);
  });
});
