import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/health', () => {
  it('returns ok with timestamp', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; time: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('discordapi_ad_server');
    expect(new Date(body.time).toString()).not.toBe('Invalid Date');
  });
});
