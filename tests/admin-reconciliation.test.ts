/**
 * Admin READ-ONLY LiqPay reconciliation — phase 3.
 *
 * Contract under test:
 *   - GET-only API endpoint behind requireAdminApi();
 *   - reuses the EXISTING pure classifier (no logic duplication);
 *   - selects/orders projects ONLY non-PII bookkeeping columns;
 *   - performs zero DB writes and zero LiqPay mutations;
 *   - private/service keys never reach the client bundle or response;
 *   - throttled sequential Status API calls over a bounded keyset window.
 *
 * Repo conventions: this file follows the static characterization pattern
 * used by order-security/admin-feedback/liqpay-ui tests (no runtime cookie
 * context is available under node --test; drift fails CI by pinning source
 * structure), plus real module-shape assertions where they add value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const ROUTE = 'app/api/admin/orders/reconciliation/route.ts';
const HELPER = 'app/lib/payment/liqpay-status-api.ts';
const PAGE = 'app/admin/(dashboard)/orders/reconciliation/page.tsx';

// ---------------- shared provider-status helper ----------------

test('RECON-API: shared server-side Status helper reuses signature primitives, action=status only', () => {
  const h = src(HELPER);
  // Reuse, do not duplicate crypto.
  assert.match(h, /liqpay-signature\.ts/);
  assert.match(h, /encodeLiqPayData|createLiqPaySignature/);
  assert.doesNotMatch(h, /createHash/, 'must not reimplement SHA-1 signing');
  assert.match(h, /action:\s*['"]status['"]/);
  assert.match(h, /version:\s*3/);
  assert.match(h, /https:\/\/www\.liqpay\.ua\/api\/request/);
  // Read-only action: no other action word may be built here.
  const bodyArea = h.slice(h.indexOf('action'));
  assert.doesNotMatch(bodyArea, /action:\s*['"](?!status['"])[a-z_]+['"]/);
  assert.doesNotMatch(h, /console\./, 'helper must not log (keys stay out of logs)');
});

test('RECON-API: CLI delegates to the shared helper (single implementation)', () => {
  const cli = src('scripts/reconcile-liqpay.mts');
  assert.match(cli, /liqpay-status-api\.ts/);
  assert.match(cli, /fetchLiqPayProviderStatus/);
  assert.doesNotMatch(cli, /createLiqPaySignature/,
    'CLI must reuse the shared signed request instead of local crypto');
});

// ---------------- route: auth + verbs ----------------

test('RECON-API: route exports ONLY a GET handler', () => {
  const r = src(ROUTE);
  assert.match(r, /export async function GET\(/);
  // No other verb handler may exist at all (module-shape level guarantee).
  assert.doesNotMatch(r, /export\s+(async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/);
});

test('RECON-API: every path runs behind requireAdminApi (401/403 fail-closed)', () => {
  const r = src(ROUTE);
  const guardAt = r.indexOf('requireAdminApi()');
  assert.ok(guardAt >= 0, 'requireAdminApi() must be called');
  assert.match(r, /if \(ctx instanceof NextResponse\) return ctx;/,
    'guard rejection must short-circuit the handler');
  assert.ok(
    guardAt < r.indexOf('.from('),
    'guard must precede any DB access'
  );
  // Unauthenticated callers receive 401 from admin-api itself (pinned):
  const api = src('app/lib/admin-api.ts');
  assert.match(api, /status:\s*401\s*\}/, 'admin-api answers 401 when no user');
});

test('RECON-API: physically free of DB mutation calls', () => {
  const r = src(ROUTE);
  for (const m of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
    assert.ok(!r.includes(m), `forbidden DB write call found: ${m}`);
  }
});

// ---------------- route: data minimization / PII ----------------

test('RECON-API: orders SELECT is an explicit non-PII column whitelist', () => {
  const r = src(ROUTE);
  assert.doesNotMatch(r, /select\('\*'\)|select\("\*"\)/,
    'wildcard selects are forbidden');
  assert.doesNotMatch(r, /email/i);
  assert.doesNotMatch(r, /customer_info|shipping_info/);
  for (const col of [
    'order_number',
    'created_at',
    'status',
    'payment_status',
    'total_amount',
    'currency',
    'liqpay_order_id',
    'liqpay_payment_id',
    'paid_at',
    'payment_method',
  ]) {
    assert.ok(r.includes(col), `expected whitelisted column ${col}`);
  }
});

test('RECON-API: no secret ever enters the response or client surface', () => {
  const r = src(ROUTE);
  assert.doesNotMatch(r, /PRIVATE_KEY/);
  assert.doesNotMatch(r, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(r, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  const p = src(PAGE);
  assert.doesNotMatch(p, /PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY|process\.env\.LIQPAY/);
  // The RAW provider payload must not be echoed wholesale into the report.
  assert.doesNotMatch(r, /JSON\.stringify\(provider\b/,
    'response must contain derived facts, not the raw provider body');
});

// ---------------- route: reuse of the pure classifier ----------------

test('RECON-API: classifier is imported, never reimplemented', () => {
  const r = src(ROUTE);
  assert.match(r, /app\/lib\/payment\/reconciliation/);
  assert.match(r, /classifyReconcileRow/);
  assert.match(r, /findDuplicatePaymentIdGroups/);
  assert.doesNotMatch(r, /mapLiqPayStatus\s*\(|sameMoneyCents\s*\(/,
    'route must not duplicate classifier internals');
});

// ---------------- route: bounded work / performance ----------------

test('RECON-API: bounded keyset window, explicit caps, sequential throttle', () => {
  const r = src(ROUTE);
  assert.doesNotMatch(r, /\.range\(/, 'offset pagination must not be used');
  assert.match(r, /\.gt\('created_at'/, 'keyset predicate on created_at required');
  assert.match(r, /\blimit\b/i);
  assert.match(r, /THROTTLE/, 'sequential pacing constant required');
  assert.match(r, /MAX_LIMIT/);
  // Window defaults/caps are documented in-file as well.
  assert.match(r, /DEFAULT_DAYS/);
});

// ---------------- UI ----------------

const pageSrc = () => src(PAGE);

test('RECON-UI: standalone client page wired to the reconciliation endpoint', () => {
  const p = pageSrc();
  assert.match(p, /['"]use client['"]/);
  assert.match(p, /\/api\/admin\/orders\/reconciliation/);
  assert.match(p, /fetch\(/);
});

test('RECON-UI: renders every classification bucket distinctly', () => {
  const p = pageSrc();
  for (const cls of [
    'OK_OK',
    'PROVIDER_NOT_FOUND',
    'UNREACHABLE',
    'PROVIDER_SUCCESS_DB_NOT_PAID',
    'DB_PAID_PROVIDER_NOT_SUCCESS',
    'AMOUNT_MISMATCH',
    'CURRENCY_MISMATCH',
    'PAID_MISSING_PAYMENT_ID',
    'STALE_ATTEMPT',
    'DUPLICATE_PAYMENT_ID',
  ]) {
    assert.ok(p.includes(cls), `missing classification label ${cls}`);
  }
});

test('RECON-UI: NOT_FOUND copy states the fact without overclaiming', () => {
  const p = pageSrc();
  assert.match(p, /Транзакція не знайдена в поточному merchant\/key context LiqPay/);
  assert.doesNotMatch(p, /платіж.*не існував|не сплачений точно/i,
    'copy must not assert that a payment never existed');
});

test('RECON-UI: critical mismatches are visually emphasized, strictly read-only', () => {
  const p = pageSrc();
  // Visual distinction mechanism for money/status mismatch + duplicates:
  const crit = p.slice(p.indexOf('CRITICAL_CLASSES'));
  assert.match(crit, /AMOUNT_MISMATCH[\s\S]{0,400}DUPLICATE_PAYMENT_ID/,
    'money mismatches and duplicates share critical severity');
  assert.match(crit, /bg-red-100/, 'critical classes get red emphasis');
  assert.doesNotMatch(p, /method:\s*['"]POST['"]|refund|auto[- ]?fix/i,
    'the page must offer no mutation affordances');
  // Last-check timestamp + checked counter are surfaced.
  assert.match(p, /generated_at|checked/);
});
