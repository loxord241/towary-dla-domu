/**
 * Minimal anonymous event analytics (stage: analytics-1).
 *
 * Contract:
 * - Exactly 6 events: product_view, add_to_cart, checkout_start,
 *   payment_success, search, traffic_source — via @vercel/analytics track().
 * - No PII: no emails, no phones, no order contents, no contacts.
 * - traffic_source is first-touch only, anonymous, localStorage-only.
 * - payment_success fires ONLY after a server-confirmed paid order
 *   (never merely from opening the success URL).
 * - No new DB tables, no Supabase usage, no cookies, no LiqPay changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ANALYTICS_EVENTS,
  buildSearchEventPayload,
  classifyTrafficSource,
  resolveFirstTouchSource,
  sanitizeSearchQuery,
  shouldFirePaymentSuccess,
} from '../app/lib/analytics.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

/* ── Event catalog ─────────────────────────────────────────────── */

test('ANALYTICS: event catalog contains exactly the agreed 6 events', () => {
  assert.deepEqual(Object.keys(ANALYTICS_EVENTS).sort(), [
    'ADD_TO_CART',
    'CHECKOUT_START',
    'PAYMENT_SUCCESS',
    'PRODUCT_VIEW',
    'SEARCH',
    'TRAFFIC_SOURCE',
  ]);
  assert.deepEqual(Object.values(ANALYTICS_EVENTS).sort(), [
    'add_to_cart',
    'checkout_start',
    'payment_success',
    'product_view',
    'search',
    'traffic_source',
  ]);
});

/* ── sanitizeSearchQuery (PII guard) ───────────────────────────── */

test('SEARCH: sanitize trims, collapses whitespace and caps at 100 chars', () => {
  assert.equal(sanitizeSearchQuery('  чайник   электрический  '), 'чайник электрический');
  assert.equal(sanitizeSearchQuery('x'.repeat(300))?.length, 100);
  assert.equal(sanitizeSearchQuery(42), null);
  assert.equal(sanitizeSearchQuery(null), null);
  assert.equal(sanitizeSearchQuery('   '), null);
  assert.equal(sanitizeSearchQuery(''), null);
  assert.equal(sanitizeSearchQuery('a\n\tb'), 'a b');
});

test('SEARCH: PII guard — emails are dropped, not sent', () => {
  assert.equal(sanitizeSearchQuery('john@example.com'), null);
  assert.equal(sanitizeSearchQuery('напишите мне a@b.co быстро'), null);
});

test('SEARCH: PII guard — phone-like input is dropped, not sent', () => {
  assert.equal(sanitizeSearchQuery('0501234567'), null);
  assert.equal(sanitizeSearchQuery('позвоните +380501234567'), null);
  assert.equal(sanitizeSearchQuery('097 314 42 21'), null);
  // Ordinary numeric queries stay: they are product-like, not contact-like.
  assert.equal(sanitizeSearchQuery('набор 4003'), 'набор 4003');
});

/* ── classifyTrafficSource ─────────────────────────────────────── */

test('TRAFFIC: empty referrer classifies as direct', () => {
  assert.equal(
    classifyTrafficSource({ referrer: '', currentHost: 'example.com', utmSource: null }),
    'direct'
  );
  assert.equal(
    classifyTrafficSource({ referrer: null, currentHost: 'example.com', utmSource: null }),
    'direct'
  );
});

test('TRAFFIC: same-host referrer is internal — null (never fired)', () => {
  assert.equal(
    classifyTrafficSource({ referrer: 'https://example.com/catalog', currentHost: 'example.com', utmSource: null }),
    null
  );
  assert.equal(
    classifyTrafficSource({ referrer: 'https://www.example.com/x', currentHost: 'example.com', utmSource: null }),
    null
  );
});

test('TRAFFIC: TikTok referrer (incl. subdomains/engine hosts) → tiktok', () => {
  for (const ref of [
    'https://www.tiktok.com/@shop',
    'https://tiktok.com/foryou',
    'https://www.tiktokv.com/share/x',
  ]) {
    assert.equal(
      classifyTrafficSource({ referrer: ref, currentHost: 'example.com', utmSource: null }),
      'tiktok',
      ref
    );
  }
});

test('TRAFFIC: Google referrer (intl domains) → google', () => {
  for (const ref of [
    'https://www.google.com/',
    'https://www.google.com.ua/search?q=x',
    'https://google.ru/',
  ]) {
    assert.equal(
      classifyTrafficSource({ referrer: ref, currentHost: 'example.com', utmSource: null }),
      'google',
      ref
    );
  }
});

test('TRAFFIC: other external referrer → other', () => {
  assert.equal(
    classifyTrafficSource({ referrer: 'https://facebook.com/x', currentHost: 'example.com', utmSource: null }),
    'other'
  );
});

test('TRAFFIC: utm_source overrides referrer classification', () => {
  assert.equal(
    classifyTrafficSource({ referrer: 'https://facebook.com/x', currentHost: 'example.com', utmSource: 'tiktok' }),
    'tiktok'
  );
  assert.equal(
    classifyTrafficSource({ referrer: 'https://www.google.com/', currentHost: 'example.com', utmSource: 'newsletter' }),
    'other'
  );
  assert.equal(
    classifyTrafficSource({ referrer: '', currentHost: 'example.com', utmSource: 'google' }),
    'google'
  );
});

/* ── first-touch persistence (localStorage contract, injected) ── */

test('TRAFFIC: first touch persists the source and reports isFirstTouch', () => {
  let stored: string | null = null;
  const read = () => stored;
  const write = (v: string) => {
    stored = v;
  };

  const first = resolveFirstTouchSource(read, write, 'tiktok');
  assert.equal(first.isFirstTouch, true);
  assert.equal(first.source, 'tiktok');
  assert.equal(stored, 'tiktok');

  // Second visit: nothing overwritten, no new event.
  const again = resolveFirstTouchSource(read, write, 'google');
  assert.equal(again.isFirstTouch, false);
  assert.equal(again.source, 'tiktok');
  assert.equal(stored, 'tiktok');
});

test('TRAFFIC: broken stored value is ignored and replaced once', () => {
  let stored = 'not-a-source';
  const read = () => stored;
  const write = (v: string) => {
    stored = v;
  };
  const res = resolveFirstTouchSource(read, write, 'direct');
  assert.equal(res.isFirstTouch, true);
  assert.equal(res.source, 'direct');
});

test('TRAFFIC: internal navigation (null candidate) never writes or fires', () => {
  let stored: string | null = null;
  const res = resolveFirstTouchSource(() => stored, () => {
    stored = 'CORRUPTED';
  }, null);
  assert.equal(res.isFirstTouch, false);
  assert.equal(res.source, null);
  assert.equal(stored, null);
});

/* ── payment_success gating ────────────────────────────────────── */

test('PAYMENT: fires once per order number, deduped locally', () => {
  let stored: string | null = null;
  const read = () => stored;
  const write = (v: string) => {
    stored = v;
  };

  assert.equal(shouldFirePaymentSuccess(read, write, 'ORD-1'), true);
  assert.equal(shouldFirePaymentSuccess(read, write, 'ORD-1'), false);
  assert.equal(shouldFirePaymentSuccess(read, write, 'ORD-2'), true);
  assert.equal(shouldFirePaymentSuccess(read, write, 'ORD-2'), false);
});

test('PAYMENT: capped dedupe list (no unbounded growth)', () => {
  let stored: string | null = null;
  const read = () => stored;
  const write = (v: string) => {
    stored = v;
  };
  for (let i = 0; i < 100; i++) {
    shouldFirePaymentSuccess(read, write, `ORD-${i}`);
  }
  const parsed = JSON.parse(stored ?? '[]') as string[];
  assert.ok(parsed.length <= 20, `list capped, got ${parsed.length}`);
});

test('PAYMENT: malformed stored data degrades to firing (server already confirmed paid)', () => {
  const res = shouldFirePaymentSuccess(() => '{broken json', () => {}, 'ORD-9');
  assert.equal(res, true);
});

test('PAYMENT: empty/absent order number never fires', () => {
  const stored: string | null = null;
  assert.equal(shouldFirePaymentSuccess(() => stored, () => {}, ''), false);
});

/* ── Static source pins: integration points ────────────────────── */

test('STATIC: product_view fired from RecentlyViewedTracker with product_id only', () => {
  const s = src('app/components/RecentlyViewedTracker.tsx');
  assert.match(s, /from '@vercel\/analytics'/);
  assert.match(s, /track\(\s*ANALYTICS_EVENTS\.PRODUCT_VIEW\s*,\s*\{\s*product_id/);
  // No contact-shaped data in any track() call.
  assert.doesNotMatch(s, /track\([^)]*(email|phone|name\s*:)/i);
});

test('STATIC: add_to_cart fired from AddToCartButton with product_id only', () => {
  const s = src('app/components/AddToCartButton.tsx');
  assert.match(s, /track\(\s*ANALYTICS_EVENTS\.ADD_TO_CART\s*,\s*\{\s*product_id/);
  assert.doesNotMatch(s, /ANALYTICS_EVENTS\.(?!ADD_TO_CART)[A-Z_]+/);
});

test('STATIC: checkout_start fired once on CheckoutForm mount', () => {
  const s = src('app/checkout/CheckoutForm.tsx');
  assert.match(s, /track\(\s*ANALYTICS_EVENTS\.CHECKOUT_START\s*\)/);
  assert.doesNotMatch(s, /ANALYTICS_EVENTS\.(?!CHECKOUT_START)[A-Z_]+/);
});

test('STATIC: search fired from SearchViewTracker with sanitized query + boolean hasResults', () => {
  const s = src('app/components/SearchViewTracker.tsx');
  assert.match(s, /track\(\s*ANALYTICS_EVENTS\.SEARCH\s*,\s*payload\s*\)/);
  assert.match(
    s,
    /buildSearchEventPayload\(/,
    'payload must come from the pure sanitizer-gated builder'
  );
  assert.match(
    s,
    /if\s*\(\s*payload\s*\)\s*\{\s*track\(/,
    'nothing fired when the sanitized query is empty/contact-shaped'
  );
  assert.match(
    s,
    /hasResults:\s*boolean/,
    'the flag stays a boolean — no numeric result counts in the props'
  );
});

test('buildSearchEventPayload: hasResults true/false, no event for empty sanitized query', () => {
  assert.deepEqual(buildSearchEventPayload('  чайник  ', true), {
    query: 'чайник',
    hasResults: true,
  });
  assert.deepEqual(buildSearchEventPayload('чайник', false), {
    query: 'чайник',
    hasResults: false,
  });
  // Contact-shaped / empty sanitized input -> null payload = no event.
  assert.equal(buildSearchEventPayload('john@example.com', true), null);
  assert.equal(buildSearchEventPayload('380501234567', true), null);
  assert.equal(buildSearchEventPayload('   ', true), null);
  assert.equal(buildSearchEventPayload('', false), null);
  assert.equal(buildSearchEventPayload(undefined, true), null);
});

test('STATIC: catalog page passes boolean hasResults derived from result total', () => {
  const page = src('app/catalog/page.tsx');
  assert.match(
    page,
    /<SearchViewTracker\s+query=\{filters\.search\}\s+hasResults=\{total\s*>\s*0\}\s*\/>/,
    'catalog page must feed the tracker a boolean (total > 0), never a count'
  );
});

test('STATIC: traffic_source captured in root layout via tracker component', () => {
  const layout = src('app/layout.tsx');
  assert.match(layout, /<TrafficSourceTracker\s*\/>/);
  const tracker = src('app/components/TrafficSourceTracker.tsx');
  assert.match(tracker, /TRAFFIC_SOURCE_STORAGE_KEY/);
  assert.match(tracker, /classifyTrafficSource\(/);
  assert.match(tracker, /resolveFirstTouchSource\(/);
  assert.match(tracker, /track\(\s*ANALYTICS_EVENTS\.TRAFFIC_SOURCE\s*,\s*\{\s*source/);
});

test('STATIC: payment_success rendered by success page, gated on server-confirmed paid', () => {
  const page = src('app/checkout/success/page.tsx');
  // Gate lives in the SERVER component: tracker receives the DB-read flag.
  assert.match(page, /paid=\{\s*payment === 'paid'\s*\}/);
  assert.match(page, /<PaymentSuccessTracker\b/);
  const tracker = src('app/components/PaymentSuccessTracker.tsx');
  // Client guard: nothing fired unless the server confirmed payment.
  assert.match(tracker, /if\s*\(!paid\s*\|\|\s*!orderNumber\)\s*return/);
  assert.match(tracker, /track\(\s*ANALYTICS_EVENTS\.PAYMENT_SUCCESS\s*\)/, 'no props — no order data sent');
  assert.match(tracker, /shouldFirePaymentSuccess\(/, 'fires at most once per order');
});

test('STATIC: no cookies, no Supabase, no LiqPay in analytics surfaces', () => {
  const files = [
    'app/lib/analytics.ts',
    'app/components/TrafficSourceTracker.tsx',
    'app/components/PaymentSuccessTracker.tsx',
    'app/components/SearchViewTracker.tsx',
  ];
  for (const f of files) {
    const s = src(f);
    assert.doesNotMatch(s, /document\.cookie/i, `${f} must not touch cookies`);
    assert.doesNotMatch(s, /createClient|@supabase\//, `${f} must not use Supabase`);
    assert.doesNotMatch(s, /liqpay/i, `${f} must not touch LiqPay`);
  }
});

test('STATIC: storage keys are anonymous and versioned', () => {
  const s = src('app/lib/analytics.ts');
  assert.match(s, /TRAFFIC_SOURCE_STORAGE_KEY = 'eshop-traffic-source-v1'/);
  assert.match(s, /PAID_ORDERS_STORAGE_KEY = 'eshop-analytics-paid-orders-v1'/);
});
