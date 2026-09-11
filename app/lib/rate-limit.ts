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
 *    TRUST ASSUMPTION (deployment: Vercel): Vercel's edge OVERWRITES
 *    x-forwarded-for with the real client IP and does not forward
 *    externally supplied values ("to prevent IP spoofing" — vercel.com/docs,
 *    System Headers → x-forwarded-for; x-real-ip is identical). The first
 *    XFF element is therefore edge-verified and NOT client-controllable.
 *    This only holds on Vercel: behind another reverse proxy (Cloudflare,
 *    nginx) or an Enterprise trusted-proxy setup, re-validate before
 *    trusting it.
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

/**
 * Extracts the rate-limit key (client IP) from request headers. The header
 * selection and its Vercel trust assumption are documented at the top of
 * this file and pinned by tests/rate-limit-xff.test.ts.
 */
export function ipFromHeaders(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? 'unknown';
}

export function clientIpOf(request: Request): string {
  return ipFromHeaders(request.headers);
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
  // payment init: signed checkout request per order; burst + hourly ceiling
  paymentInit: [
    { max: 5, windowMs: 60_000 },
    { max: 20, windowMs: 60 * 60_000 },
  ],
  // anonymous feedback: strict anti-spam (no auth, no persistence yet)
  feedback: [
    { max: 3, windowMs: 60_000 },
    { max: 5, windowMs: 60 * 60_000 },
  ],
  // product reviews: strict anti-spam (anonymous submission, pre-moderation)
  reviews: [
    { max: 3, windowMs: 60_000 },
    { max: 10, windowMs: 60 * 60_000 },
  ],
  // review READS (GET /api/reviews pagination): generous, abuse-only
  // ceiling — a real user pages through a handful of pages per PDP visit.
  reviewsGet: [{ max: 60, windowMs: 60_000 }],
  // restock notify («Повідомити про наявність»): one visitor needs a couple
  // of attempts at most (a typo retry), so a tight burst over a 10-minute
  // window; no hourly ceiling — the valid-email gate already bounds abuse.
  restockNotify: [{ max: 5, windowMs: 10 * 60_000 }],
  // read-only catalog preview: generous, abuse-only ceiling
  cartPreview: [{ max: 120, windowMs: 60_000 }],
  // search autocomplete (GET /api/search/suggest): a typing user fires a
  // debounced request every ~250ms — 60/min absorbs real typing bursts,
  // still caps scripted hammering
  searchSuggest: [{ max: 60, windowMs: 60_000 }],
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
  // Nova Post proxies (server-side, read-only provider calls): city search
  // is per-keystroke autocomplete, branch lookup fires once per city pick,
  // delivery cost calls the provider calculation endpoint (heaviest).
  novaPoshtaSettlements: [{ max: 60, windowMs: 60_000 }],
  novaPoshtaDivisions: [{ max: 90, windowMs: 60_000 }],
  novaPoshtaStreets: [{ max: 90, windowMs: 60_000 }],
  novaPoshtaDeliveryCost: [{ max: 12, windowMs: 60_000 }],
  // Ukrposhta proxies: the provider publishes NO rate limits and the
  // classifier is slower/heavier than Nova Post (a per-city office list
  // is ~250-580KB) — conservative ceilings well below the Nova Post ones.
  ukrposhtaSettlements: [{ max: 12, windowMs: 60_000 }],
  ukrposhtaOffices: [{ max: 12, windowMs: 60_000 }],
  ukrposhtaDeliveryCost: [{ max: 12, windowMs: 60_000 }],
  // admin login (server action): brute-force protection. Same shape as the
  // `lookup` pair-guessing ceiling: a per-IP burst plus an hourly ceiling.
  // IP comes from headers() in the server action (same proxy-set XFF the
  // edge overwrites — see the trust note at the top of this file).
  adminLogin: [
    { max: 5, windowMs: 60_000 },
    { max: 20, windowMs: 60 * 60_000 },
  ],
} as const;

/**
 * Applies named rules keyed by the caller (server actions and other
 * non-Request contexts where the key is built from headers() instead of a
 * Request object). Returns the raw decision; the caller decides how to
 * surface a rejection (429 JSON, redirect, ...).
 */
export function enforceRateLimitByKey(
  key: string,
  routeName: keyof typeof RATE_RULES,
): RateDecision {
  return checkRateLimit(
    `${routeName}:${key}`,
    RATE_RULES[routeName] as unknown as RateRule[]
  );
}

/**
 * Applies named rules; returns a ready-to-send 429 when limited,
 * or null when the request may proceed.
 */
export function enforceRateLimit(
  request: Request,
  routeName: keyof typeof RATE_RULES,
): NextResponse | null {
  const decision = enforceRateLimitByKey(clientIpOf(request), routeName);
  if (decision.ok) return null;
  return NextResponse.json(
    { error: 'Забагато запитів. Спробуйте пізніше' },
    {
      status: 429,
      headers: { 'Retry-After': String(Math.max(1, decision.retryAfterSec)) },
    }
  );
}
