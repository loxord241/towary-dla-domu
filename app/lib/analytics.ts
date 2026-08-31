/**
 * Minimal anonymous event analytics over @vercel/analytics track().
 *
 * Privacy contract (2026-08 analytics stage):
 * - Exactly six events, no PII: product ids, sanitized search text,
 *   traffic-source class. No contacts, no order contents, no cookies.
 * - Traffic source is FIRST-TOUCH only, kept in localStorage under
 *   `eshop-traffic-source-v1` and never overwritten after the first visit.
 * - payment_success fires at most once per order number; the dedupe list
 *   lives only in the visitor's localStorage and is never sent anywhere.
 * - Pure module: no React, no DOM, no Supabase. Storage access is injected
 *   by the client islands (unit-tested in Node like cart/favorites storage).
 */

export const ANALYTICS_EVENTS = {
  PRODUCT_VIEW: 'product_view',
  ADD_TO_CART: 'add_to_cart',
  CHECKOUT_START: 'checkout_start',
  PAYMENT_SUCCESS: 'payment_success',
  SEARCH: 'search',
  TRAFFIC_SOURCE: 'traffic_source',
} as const;

export const TRAFFIC_SOURCE_STORAGE_KEY = 'eshop-traffic-source-v1';

export const PAID_ORDERS_STORAGE_KEY = 'eshop-analytics-paid-orders-v1';

/** localStorage dedupe list for fired payment_success events. */
export const MAX_PAID_ORDER_ENTRIES = 20;

export type TrafficSource = 'direct' | 'tiktok' | 'google' | 'other';

const SOURCES: readonly TrafficSource[] = ['direct', 'tiktok', 'google', 'other'];

const MAX_SEARCH_QUERY_LENGTH = 100;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

/** A run of 10+ digits (separators tolerated) is treated as a phone — PII, dropped. */
const PHONE_LIKE_RE = /\d{10,}/;

/** Separators that may legitimately split a phone number the user typed. */
const PHONE_SEPARATOR_RE = /[\s()\u2013\u2014-]/g;

const EMAIL_HINT_RE = /@/;

/**
 * Defensive search-query sanitizer: trims, collapses whitespace, strips
 * control characters, caps length, and refuses contact-shaped input
 * (emails, phone-like digit runs). Empty results degrade to null.
 */
export function sanitizeSearchQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (!cleaned) return null;
  if (EMAIL_HINT_RE.test(cleaned) || PHONE_LIKE_RE.test(cleaned.replace(PHONE_SEPARATOR_RE, ''))) {
    return null;
  }
  return cleaned;
}

function hostOf(referrer: string): string | null {
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHost(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function isGoogleHost(host: string): boolean {
  // Matches google.com, google.com.ua, google.ru, www.google.* etc.
  return /(^|\.)google\./.test(host);
}

function sourceFromUtm(utmSource: string): TrafficSource | null {
  const value = utmSource.trim().toLowerCase();
  if (!value) return null;
  if (isHost(value, 'tiktok.com') || value === 'tiktok') return 'tiktok';
  if (isHost(value, 'google.com') || value === 'google' || isGoogleHost(value)) {
    return 'google';
  }
  if (value === 'direct') return 'direct';
  return 'other';
}

/**
 * Classify a page-load into an anonymous traffic source.
 * Returns null for internal navigation (same-host referrer): the caller
 * must neither persist nor fire anything for such loads.
 * `utmSource` (when present) wins over the document referrer.
 */
export function classifyTrafficSource(input: {
  referrer?: string | null;
  currentHost?: string | null;
  utmSource?: string | null;
}): TrafficSource | null {
  const utm = typeof input.utmSource === 'string' ? input.utmSource : null;
  if (utm) {
    const fromUtm = sourceFromUtm(utm);
    if (fromUtm) return fromUtm;
  }

  const referrer = typeof input.referrer === 'string' ? input.referrer : '';
  if (!referrer) return 'direct';

  const host = hostOf(referrer);
  if (!host) return 'other';

  const current = (input.currentHost ?? '').toLowerCase();
  if (current && (host === current || host.endsWith(`.${current}`))) return null;

  if (isHost(host, 'tiktok.com') || isHost(host, 'tiktokv.com')) return 'tiktok';
  if (isGoogleHost(host)) return 'google';
  return 'other';
}

function isStoredSource(raw: string | null | undefined): raw is TrafficSource {
  return typeof raw === 'string' && (SOURCES as readonly string[]).includes(raw);
}

/**
 * First-touch resolution: an existing valid stored source is kept as-is
 * (no overwrite, no re-fire); otherwise the candidate is persisted and
 * reported as the first touch. A null candidate (internal navigation)
 * never touches storage and never fires.
 */
export function resolveFirstTouchSource(
  read: () => string | null,
  write: (value: string) => void,
  candidate: TrafficSource | null
): { source: TrafficSource | null; isFirstTouch: boolean } {
  const stored = read();
  if (isStoredSource(stored)) {
    return { source: stored, isFirstTouch: false };
  }
  if (!candidate) {
    return { source: null, isFirstTouch: false };
  }
  write(candidate);
  return { source: candidate, isFirstTouch: true };
}

/**
 * payment_success dedupe: returns true only the first time a given order
 * number is seen. The list is capped at MAX_PAID_ORDER_ENTRIES. Corrupted
 * storage degrades to firing — the server-side `paid` flag is the real
 * confirmation; this guard only suppresses obvious duplicate fires.
 */
export function shouldFirePaymentSuccess(
  read: () => string | null,
  write: (value: string) => void,
  orderNumber: string
): boolean {
  if (!orderNumber) return false;

  let fired: unknown;
  const raw = read();
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      fired = JSON.parse(raw);
    } catch {
      fired = null;
    }
  }

  const list = Array.isArray(fired)
    ? fired.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_PAID_ORDER_ENTRIES)
    : [];

  if (list.includes(orderNumber)) return false;

  const next = [orderNumber, ...list].slice(0, MAX_PAID_ORDER_ENTRIES);
  try {
    write(JSON.stringify(next));
  } catch {
    // Storage failures degrade to firing — server already confirmed paid.
  }
  return true;
}
