const BOT_UA_RE = /bot|crawl|spider|preview/i;

export type EventFilterInput = {
  method: string;
  ua: string | null | undefined;
};

/**
 * Returns false if the request should NOT generate an ad_events row.
 * - HEAD requests don't count as impressions
 * - UAs matching common bot patterns are filtered out
 *
 * Used by P5.1 (impression / click recording) — return value of `false`
 * means skip the INSERT (caller should still serve the response normally).
 */
export function shouldRecordEvent(input: EventFilterInput): boolean {
  if (input.method.toUpperCase() === 'HEAD') return false;
  const ua = input.ua ?? '';
  if (ua.length === 0) return true; // empty UA: count it
  return !BOT_UA_RE.test(ua);
}
