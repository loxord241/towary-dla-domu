import { createHmac } from 'node:crypto';

/**
 * Pure core of the SHARED (cross-instance) rate-limit layer — no
 * next/server import so sandbox harnesses and node:test can load it
 * directly (2026-09-13, owner-approved «общий лимитер»).
 *
 * The authoritative decision lives in Postgres (migration 047:
 * rate_limit_hits + rate_limit_hit RPC); the identifier stored is an HMAC
 * of the IP (rate-limit:v1), never the IP itself. Any RPC failure fails
 * OPEN — the in-process decision in app/lib/rate-limit.ts stands, so a
 * transient Supabase outage cannot take the checkout down.
 */

export interface RateRule {
  /** max accepted requests per sliding window */
  max: number;
  windowMs: number;
}

export interface RateDecision {
  ok: boolean;
  /** seconds until the strictest violated window frees a slot */
  retryAfterSec: number;
}

/** Thin seam so tests can stub the RPC without a real Supabase client. */
export type RateLimitRpc = (
  fn: 'rate_limit_hit',
  args: { p_name: string; p_ip_hash: string; p_rules: unknown }
) => Promise<{ data: unknown; error: { message: string } | null }>;

/** Domain-separated HMAC — the IP itself is never persisted. */
export function rateLimitIpHash(key: string, secret: string): string {
  return createHmac('sha256', secret)
    .update('rate-limit:v1:' + key)
    .digest('hex');
}

/** RATE_RULES entries → the JSON shape the rate_limit_hit RPC expects. */
export function sharedRulesPayload(rules: readonly RateRule[]): {
  max: number;
  window_sec: number;
}[] {
  return rules.map((r) => ({
    max: r.max,
    window_sec: Math.round(r.windowMs / 1000),
  }));
}

export async function sharedRateDecision(
  rpc: RateLimitRpc,
  routeName: string,
  rules: readonly RateRule[],
  key: string,
  secret: string
): Promise<RateDecision> {
  try {
    const { data, error } = await rpc('rate_limit_hit', {
      p_name: routeName,
      p_ip_hash: rateLimitIpHash(key, secret),
      p_rules: sharedRulesPayload(rules),
    });
    if (error) throw new Error(error.message);
    const res = data as { allowed?: unknown; retry_after_sec?: unknown } | null;
    if (!res || typeof res.allowed !== 'boolean') {
      throw new Error('unexpected rate_limit_hit shape');
    }
    return {
      ok: res.allowed,
      retryAfterSec: res.allowed
        ? 0
        : Math.max(1, Number(res.retry_after_sec) || 1),
    };
  } catch (err) {
    console.error(
      `shared rate limit unavailable (${routeName}) — fail open:`,
      err instanceof Error ? err.message : err
    );
    return { ok: true, retryAfterSec: 0 };
  }
}
