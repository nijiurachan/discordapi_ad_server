import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('returns json with status field and timestamp regardless of dependency state', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as {
      status: string;
      service: string;
      time: string;
      checks: { db: string; s3?: string };
    };
    expect(body.service).toBe('discordapi_ad_server');
    expect(['ok', 'degraded']).toContain(body.status);
    expect(typeof body.checks.db).toBe('string');
    expect(typeof body.checks.s3).toBe('string');
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });
});
