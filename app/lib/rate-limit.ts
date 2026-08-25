import { NextResponse } from 'next/server';

/**
 * In-process sliding-window rate limiter for public sensitive endpoints.
 *
 * Scope & honest limitations:
 *  - Per-IP state lives in this Node process BY DESIGN: it never persists
 *    identifiers, which keeps anonymous endpoints (feedback) truly
 *    anonymous. It protects a single-server deployment and resets on
 *    restart. Cross-instance protection is provided separately where it
 *    matters: the feedback endpoint additionally enforces a shared daily
 *    cap counted in the DB (identifier-free) — see app/api/feedback/route.ts.
 *    Future sensitive features (e.g. promo validation) should use the same
 *    shared-cap pattern instead of persisting IPs.
 *  - Buckets are keyed by client IP + route name; IP comes from
 *    x-forwarded-for / x-real-ip set by the upstream proxy.
 *  - Only ACCEPTED requests count toward limits; rejected ones neither
 *    extend nor deepen the block (prevents permanent starvation of
 *    clients behind shared NATs).
 */

interface Window {
  hits: number[];
}

const buckets = new Map<string, Window>();

const MAX_BUCKETS = 20_000;

function pruneBuckets(now: number) {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, win] of buckets) {
    if (!win.hits.some((t) => t > now)) buckets.delete(key);
    if (buckets.size <= MAX_BUCKETS / 2) break;
  }
}

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

export function checkRateLimit(key: string, rules: RateRule[]): RateDecision {
  const now = Date.now();
  pruneBuckets(now);

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { hits: [] };
    buckets.set(key, bucket);
  }

  // Single prune using the longest window so multi-rule evaluation
  // always sees complete history.
  const maxWindowMs = Math.max(...rules.map((r) => r.windowMs));
  bucket.hits = bucket.hits.filter((t) => t > now - maxWindowMs);

  let retryAfterSec = 0;
  for (const rule of rules) {
    const windowHits = bucket.hits.filter((t) => t > now - rule.windowMs);
    if (windowHits.length >= rule.max) {
      const oldest = Math.min(...windowHits);
      retryAfterSec = Math.max(
        retryAfterSec,
        Math.ceil((oldest + rule.windowMs - now) / 1000)
      );
    }
  }

  if (retryAfterSec > 0) {
    return { ok: false, retryAfterSec };
  }

  bucket.hits.push(now);
  return { ok: true, retryAfterSec: 0 };
}

export function clientIpOf(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Named rule sets for public sensitive endpoints. */
export const RATE_RULES = {
  // order creation: short anti-spam burst + hourly ceiling
  orders: [
    { max: 3, windowMs: 60_000 },
    { max: 10, windowMs: 60 * 60_000 },
  ],
  // guest lookup: brute-force pair guessing protection
  lookup: [
    { max: 5, windowMs: 60_000 },
    { max: 20, windowMs: 60 * 60_000 },
  ],
  // anonymous feedback: strict anti-spam (no auth, no persistence yet)
  feedback: [
    { max: 3, windowMs: 60_000 },
    { max: 5, windowMs: 60 * 60_000 },
  ],
  // read-only catalog preview: generous, abuse-only ceiling
  cartPreview: [{ max: 120, windowMs: 60_000 }],
  // Yugcontract preview is admin-only, but every run downloads the FULL
  // provider feed (~200k rows) and hits an external B2B API — hard ceiling
  yugcontractPreview: [{ max: 3, windowMs: 10 * 60_000 }],
  // Category tree is a much lighter payload than the price feed
  yugcontractCategories: [{ max: 6, windowMs: 10 * 60_000 }],
  // Import orchestration: start creates checkpoints, run executes exactly
  // ONE batch per call, status is a cheap SELECT — all admin-only.
  yugcontractImportStart: [{ max: 3, windowMs: 10 * 60_000 }],
  yugcontractImportRun: [{ max: 30, windowMs: 10 * 60_000 }],
  yugcontractImportStatus: [{ max: 60, windowMs: 10 * 60_000 }],
} as const;

/**
 * Applies named rules; returns a ready-to-send 429 when limited,
 * or null when the request may proceed.
 */
export function enforceRateLimit(
  request: Request,
  routeName: keyof typeof RATE_RULES,
): NextResponse | null {
  const decision = checkRateLimit(
    `${routeName}:${clientIpOf(request)}`,
    RATE_RULES[routeName] as unknown as RateRule[]
  );
  if (decision.ok) return null;
  return NextResponse.json(
    { error: 'Забагато запитів. Спробуйте пізніше' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, decision.retryAfterSec)) },
    }
  );
}
