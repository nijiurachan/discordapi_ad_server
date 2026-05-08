import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('maps res.status 1:1 with body.status and reports both probe results', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect([200, 503]).toContain(res.status);
    const body = (await res.json()) as {
      status: string;
      service: string;
      time: string;
      checks: { db: string; s3?: string };
    };
    expect(body.service).toBe('discordapi_ad_server');
    if (res.status === 200) {
      expect(body.status).toBe('ok');
    } else {
      expect(body.status).toBe('degraded');
    }
    expect(typeof body.checks.db).toBe('string');
    expect(typeof body.checks.s3).toBe('string');
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });
});
