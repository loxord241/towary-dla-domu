/**
 * B1+B2 cancel/paid interlock + LiqPay sandbox/live config cross-check.
 *
 * Layers under contract (defense-in-depth, server-side authoritative):
 *   1. app/lib/admin-order-cancel.ts      — pure cancellation decision
 *   2. app/api/admin/orders/[id]/route.ts — PATCH reads payment_status before
 *      calling admin_cancel_order and maps a paid order to 409
 *   3. database/migrations/018_paid_order_interlock.sql — DB-level guard
 *      inside admin_cancel_order (NOT applied automatically)
 *   4. app/admin/(dashboard)/orders/page.tsx — UI hides the plain cancel for
 *      paid orders (auxiliary only, never the sole protection)
 *   5. app/lib/payment/order-payment-update.ts applyPaid — covered by
 *      payment-gateway-adapter / payment-routes tests
 *
 * Static invariant tests follow the repo pattern (liqpay-migration.test.ts,
 * orders-revoke-migration.test.ts). No DB access, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const {
  decideAdminCancellation,
  PAID_CANCEL_REJECTION_MESSAGE,
} = await import('../app/lib/admin-order-cancel.ts');

// ---------------- 1. pure decision ----------------

test('INTERLOCK-B2: paid order is NOT cancellable through the admin flow', () => {
  const d = decideAdminCancellation({ status: 'pending', payment_status: 'paid' });
  assert.equal(d.allowed, false);
});

test('INTERLOCK-B2: unpaid/pending/failed payment does not block cancellation', () => {
  for (const ps of ['unpaid', 'pending', 'failed']) {
    assert.deepEqual(decideAdminCancellation({ status: 'pending', payment_status: ps }), {
      allowed: true,
    });
  }
});

test('INTERLOCK-B2: refunded payment may be cancelled (money already returned)', () => {
  assert.equal(
    decideAdminCancellation({ status: 'confirmed', payment_status: 'refunded' }).allowed,
    true
  );
});

test('INTERLOCK-B2: missing fields never crash and default to cancellable (RPC still validates)', () => {
  assert.deepEqual(decideAdminCancellation({}), { allowed: true });
  assert.deepEqual(decideAdminCancellation({ status: null, payment_status: null }), {
    allowed: true,
  });
});

// ---------------- 2. PATCH route statics ----------------

const route = readFileSync(
  join(process.cwd(), 'app/api/admin/orders/[id]/route.ts'),
  'utf8'
);

test('INTERLOCK-B2: PATCH resolves the cancel decision BEFORE invoking the RPC', () => {
  // The decision must be made on data read from the guarded SELECT, not after
  // the RPC fired — otherwise stock restore could already have happened.
  const idxRead = route.indexOf('decideAdminCancellation');
  const idxRpc = route.indexOf('ctx.serviceClient.rpc(');
  assert.ok(idxRead > -1, 'route must call decideAdminCancellation');
  assert.ok(idxRpc > -1, 'route must invoke the admin RPC');
  assert.ok(idxRead < idxRpc, 'cancellation guard must run before the RPC call');
});

test('INTERLOCK-B2: rejected paid cancellation returns HTTP 409 without RPC side effects', () => {
  // The canonical rejection text lives in the pure module (single source).
  assert.equal(
    PAID_CANCEL_REJECTION_MESSAGE,
    'Оплачене замовлення не можна скасувати — спочатку оформіть повернення коштів (refund)'
  );
  assert.ok(route.includes('PAID_CANCEL_REJECTION_MESSAGE'), 'route must use the canonical message');
  assert.match(route, /status: 409/);
});

test('INTERLOCK-B2: patch whitelist unchanged — client can still not address payment_status', () => {
  assert.match(route, /payment_status\/prices\/stock are not\s*\n?\s*\* addressable|Whitelist the single mutable field/);
});

// ---------------- 3. migration 018 statics ----------------

const MIGRATION_PATH = 'database/migrations/018_paid_order_interlock.sql';
let m18: string;
try {
  m18 = readFileSync(join(process.cwd(), MIGRATION_PATH), 'utf8');
} catch {
  m18 = '';
}

test('MIGRATION-018: file exists in the repository (prepared, applying is a separate GO)', () => {
  assert.ok(m18.length > 0, `${MIGRATION_PATH} must exist`);
});

test('MIGRATION-018: recreates admin_cancel_order as SECURITY DEFINER with fixed search_path', () => {
  assert.match(m18, /create or replace function public\.admin_cancel_order\(p_order_id uuid\)/i);
  assert.match(m18, /security definer/i);
  assert.match(m18, /set search_path = public/i);
});

test('MIGRATION-018: raises PAID_ORDER_NOT_CANCELLABLE (P0409) when payment_status=Paid', () => {
  assert.match(m18, /payment_status/i);
  assert.match(m18, /PAID_ORDER_NOT_CANCELLABLE/);
  assert.match(m18, /errcode = 'P0409'/);
});

test('MIGRATION-018: paid guard fires BEFORE any stock restore write', () => {
  const guardIdx = m18.indexOf('PAID_ORDER_NOT_CANCELLABLE');
  const restockIdx = m18.search(/update products\b/i);
  assert.ok(guardIdx > -1 && restockIdx > -1);
  assert.ok(guardIdx < restockIdx, 'stock restore must be unreachable for a paid order');
});

test('MIGRATION-018: keeps the atomic conditional UPDATE on pending/confirmed rows', () => {
  assert.match(m18, /where id = p_order_id and status in \('pending', 'confirmed'\)/i);
});

test('MIGRATION-018: does NOT redefine expire_pending_orders or LiqPay bookkeeping', () => {
  // Mentioning the RPC in comments is fine; redefining it is not.
  assert.doesNotMatch(m18, /create or replace function public\.expire_pending_orders/i);
  assert.doesNotMatch(
    m18,
    /alter table orders add column.*liqpay_/i
  );
});

test('MIGRATION-018: grants/revoke statement identical to 007 (service_role only)', () => {
  assert.match(m18, /revoke all on function public\.admin_cancel_order\(uuid\) from public/i);
  assert.match(m18, /revoke execute on function public\.admin_cancel_order\(uuid\) from anon, authenticated/i);
  assert.match(m18, /grant execute on function public\.admin_cancel_order\(uuid\) to service_role/i);
});

test('MIGRATION-018: created WITHOUT destructive statements (no drop table/column/truncate)', () => {
  for (const bad of [/drop table/i, /drop column/i, /truncate\b/i, /delete from/i]) {
    assert.doesNotMatch(m18, bad);
  }
});

// ---------------- 4. admin UI statics ----------------

const ui = readFileSync(
  join(process.cwd(), 'app/admin/(dashboard)/orders/page.tsx'),
  'utf8'
);

test('INTERLOCK-B2: UI renders the plain cancel button ONLY for non-paid payments', () => {
  // The button block condition must include the payment axis.
  assert.match(
    ui,
    /\[\s*'pending',\s*'confirmed'\s*\]\.includes\(details\.order\.status\) &&\s*details\.order\.payment_status !== 'paid'/
  );
});

test('INTERLOCK-B2: UI shows an explanatory hint instead of cancel for paid orders', () => {
  assert.match(ui, /payment_status === 'paid'/);
  assert.match(ui, /Оплата вже отримана/i);
});

// ---------------- 5. config cross-check ----------------

const { getLiqPayConfig, detectLiqPayKeyMode } = await import(
  '../app/lib/payment/liqpay-config.ts'
);

function setEnv(pub: string | undefined, flag: string | undefined) {
  if (pub === undefined) delete process.env.LIQPAY_PUBLIC_KEY;
  else process.env.LIQPAY_PUBLIC_KEY = pub;
  if (flag === undefined) delete process.env.LIQPAY_SANDBOX;
  else process.env.LIQPAY_SANDBOX = flag;
  process.env.LIQPAY_PRIVATE_KEY ??= 'priv';
}

test('CONFIG-CROSSCHECK: documented key modes are detectable by public-key prefix', () => {
  assert.equal(detectLiqPayKeyMode('sandbox_i33111011000'), 'sandbox');
  assert.equal(detectLiqPayKeyMode('i33111011000'), 'live');
});

test('CONFIG-CROSSCHECK: LIQPAY_SANDBOX=1 with a live-type public key is a hard misconfiguration', () => {
  setEnv('i33111011000', '1');
  assert.throws(() => getLiqPayConfig(), /LIQPAY_CONFIG_MISMATCH.*LIQPAY_SANDBOX=1/);
});

test('CONFIG-CROSSCHECK: sandbox keys WITHOUT sandbox mode are equally refused', () => {
  setEnv('sandbox_i33111011000', undefined);
  assert.throws(() => getLiqPayConfig(), /LIQPAY_CONFIG_MISMATCH.*LIQPAY_SANDBOX/);
});

test('CONFIG-CROSSCHECK: consistent pairs remain valid (sandbox and live)', () => {
  setEnv('sandbox_i33111011000', '1');
  assert.equal(getLiqPayConfig().sandbox, true);
  setEnv('i33111011000', '0');
  assert.equal(getLiqPayConfig().sandbox, false);
});

test('CONFIG-CROSSCHECK: mismatch errors never leak the private key value or name-only heuristics', () => {
  setEnv('i33111011000', '1');
  try {
    getLiqPayConfig();
    assert.fail('must throw');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.doesNotMatch(msg, /private_key/i, 'error text must not embed private material context');
    assert.doesNotMatch(msg, /9ydlqKM/, 'no secret fragments');
  }
});
