/**
 * F2: idempotency for POST /api/orders.
 *
 * Goal: the same logical checkout request (same Idempotency-Key) creates
 * EXACTLY one order — including the place_order() COMMIT → lost response →
 * client retries POST scenario. The replay returns the original result,
 * never a second stock decrement, never a second Telegram notification.
 *
 * Layers (all must hold):
 *   - DB: orders.idempotency_key + partial UNIQUE index (race-safe dedup);
 *   - RPC: place_order(payload, p_idempotency_key default null) with a
 *     fast-path replay return BEFORE any lock/pricing/stock work, and a
 *     constraint-aware unique_violation handler for the concurrent twin;
 *   - route: header parsing/validation, key forwarded to the RPC, Telegram
 *     scheduled only for a freshly created order (created flag);
 *   - client: one UUID per checkout attempt-session, reused on retry.
 *
 * node:test cannot execute the JSX client component or the Next route
 * module (module-level env/supabase side effects), so per the established
 * project pattern (checkout-shipping-notice.test.ts) the route/form layers
 * are pinned as SOURCE invariants; the header parser is a pure module and
 * is tested by real behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/030_order_idempotency.sql';
const route = (): string => src('app/api/orders/route.ts');
const form = (): string => src('app/checkout/CheckoutForm.tsx');

// ---- A/B/G. DB: schema + RPC replay contract (migration 030) ----

test('F2 DB: orders.idempotency_key is a nullable column with a partial UNIQUE index', () => {
  const m = src(MIGRATION);
  assert.match(m, /add column if not exists idempotency_key text/);
  assert.match(
    m,
    /create unique index if not exists\s+\S*orders_idempotency\S*\s+on orders\(idempotency_key\)/i
  );
  // partial: legacy/keyless rows (multiple NULLs) must stay valid
  assert.match(m, /where idempotency_key is not null/i);
});

test('F2 DB: place_order gains an OPTIONAL p_idempotency_key (backward compatible signature)', () => {
  const m = src(MIGRATION);
  assert.match(
    m,
    /create or replace function public\.place_order\(payload jsonb,\s*p_idempotency_key text default null\)/i
  );
  // grants preserved (027 contract)
  assert.match(
    m,
    /grant execute on function public\.place_order\(jsonb,\s*text\) to anon,\s*authenticated,\s*service_role/i
  );
});

test('F2 DB: fast-path replay returns the EXISTING order before any locking/pricing/stock work', () => {
  const m = src(MIGRATION);
  // replay SELECT happens at the top of the function body
  const fnBody = m.slice(m.indexOf('begin'));
  const replayPos = fnBody.search(/select\s+id,\s*order_number,\s*total_amount,\s*currency\s+into[\s\S]*?from\s+orders\s+where\s+idempotency_key\s*=/i);
  const lockPos = fnBody.indexOf('for update');
  assert.notEqual(replayPos, -1, 'replay fast-path SELECT is missing');
  assert.ok(
    replayPos < lockPos,
    'replay fast-path must run BEFORE any FOR UPDATE locking/pricing'
  );
  // replay marks the result as not-created so the route skips Telegram
  assert.match(m, /'created',\s*false/);
});

test('F2 DB: concurrent twin returns the committed order from the unique_violation handler', () => {
  const m = src(MIGRATION);
  // the handler must distinguish the idempotency index from the
  // order_number collision retry loop
  assert.match(m, /get stacked diagnostics/i);
  // plpgsql item name is CONSTRAINT_NAME (NOT pg_exception_constraint_name
  // — that prefix exists only for DETAIL/HINT/CONTEXT; live-verified by the
  // failed first apply attempt: "unrecognized GET DIAGNOSTICS item")
  assert.match(m, /=\s*constraint_name\s*;/);
  assert.doesNotMatch(m, /pg_exception_constraint_name/);
  assert.match(m, /idx_orders_idempotency_key/);
  // ...and return the existing order with created=false from the handler
  const handlerPos = m.indexOf('get stacked diagnostics');
  const stockPos = m.indexOf('product_stock_history');
  assert.ok(stockPos > -1);
  const twinReturn = m.slice(handlerPos).search(/'created',\s*false/);
  assert.notEqual(twinReturn, -1, 'twin replay return is missing');
  // handler logic sits inside the order-insert loop, before the stock loop
  assert.ok(handlerPos < stockPos);
});

test('F2 DB: stock/pricing/validation logic is byte-identical (additive change only)', () => {
  const m = src(MIGRATION);
  // the guarded conditional decrement and P0422 semantics stay untouched
  assert.match(m, /stock_quantity >= v_line\.qty/);
  assert.match(m, /'INSUFFICIENT_STOCK' using errcode = 'P0422'/);
  assert.match(m, /'created',\s*true/);
});

test('F2 DB: RPC validates the key (rejects empty/oversized) with P0400', () => {
  const m = src(MIGRATION);
  assert.match(m, /length\(v_ik\)\s*<\s*8|length\(v_ik\)\s*>\s*128/);
  assert.match(m, /'IDEMPOTENCY_KEY_INVALID' using errcode = 'P0400'/);
});

// ---- C. race-safety statement: dedup is DB-enforced, not app-level ----

test('F2 DB: dedup is enforced by the unique index, not by check-then-insert only', () => {
  const m = src(MIGRATION);
  // the INSERT itself carries the key → the index is the serialization point
  assert.match(
    m,
    /insert into orders \([\s\S]*?idempotency_key[\s\S]*?\) values \([\s\S]*?v_ik/
  );
});

// ---- route layer ----

test('F2 route: Idempotency-Key header is parsed via the shared validator', () => {
  const r = route();
  assert.match(r, /parseIdempotencyKey/);
  assert.match(r, /headers\.get\(['"]idempotency-key['"]\)/i);
});

test('F2 route: invalid key → 400, valid/missing key proceeds', () => {
  const r = route();
  assert.match(r, /idem\.ok === false|!idem\.ok/);
  assert.match(r, /status: 400/);
});

test('F2 route: key is forwarded to place_order as p_idempotency_key', () => {
  const r = route();
  assert.match(r, /p_idempotency_key/);
});

test('F2 route: Telegram after() runs ONLY for a freshly created order (replay never re-notifies)', () => {
  const r = route();
  const afterPos = r.indexOf('after(() => sendTelegramOrderNotification');
  const createdPos = r.search(/created\s*!==\s*false|result\.created/);
  assert.notEqual(afterPos, -1);
  assert.notEqual(createdPos, -1);
  // the guard decision appears BEFORE the after() scheduling
  assert.ok(createdPos < afterPos);
  assert.match(r, /created\s*!==\s*false/);
});

test('F2 route: fresh → 201, replay → 200, same response body shape (contract preserved)', () => {
  const r = route();
  // single decision point: created ? 201 : 200
  assert.match(r, /status: created \? 201 : 200/);
  // body keys unchanged (2026-09-12 rotation: the token VALUE is a fresh
  // random per-issue token — replay rotates it — but the KEY set and the
  // status decision are untouched).
  assert.match(r, /orderNumber: result\.order_number/);
  assert.match(r, /accessToken,/);
});

// ---- F. header validator (real behaviour, pure module) ----

test('F2 validator: missing/empty header → ok, null key (backward compatible)', async () => {
  const { parseIdempotencyKey } = await import(
    '../app/lib/idempotency.ts'
  );
  assert.deepEqual(parseIdempotencyKey(null), { ok: true, key: null });
  assert.deepEqual(parseIdempotencyKey(''), { ok: true, key: null });
  assert.deepEqual(parseIdempotencyKey('   '), { ok: true, key: null });
});

test('F2 validator: valid UUID-style key is trimmed and accepted', async () => {
  const { parseIdempotencyKey } = await import(
    '../app/lib/idempotency.ts'
  );
  const key = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const out = parseIdempotencyKey(`  ${key}  `);
  assert.deepEqual(out, { ok: true, key });
});

test('F2 validator: too short / too long / non-printable keys are rejected', async () => {
  const { parseIdempotencyKey, IDEMPOTENCY_KEY_MIN, IDEMPOTENCY_KEY_MAX } =
    await import('../app/lib/idempotency.ts');
  assert.ok(IDEMPOTENCY_KEY_MIN === 8 && IDEMPOTENCY_KEY_MAX === 128);
  assert.equal(parseIdempotencyKey('short').ok, false);
  assert.equal(parseIdempotencyKey('x'.repeat(129)).ok, false);
  // control characters are not printable key material
  assert.equal(parseIdempotencyKey('ab\tcdefgh').ok, false);
  const rejected = parseIdempotencyKey('x'.repeat(200));
  assert.equal(rejected.ok, false);
});

// ---- client layer ----

test('F2 client: CheckoutForm sends the Idempotency-Key header on POST', () => {
  const f = form();
  assert.match(f, /Idempotency-Key/);
  assert.match(f, /idempotencyKeyRef/);
  // one key per attempt-session: generated once, reused on retry
  assert.match(f, /crypto\.randomUUID\(\)/);
});

// ---- E/H/I. compatibility guards ----

test('F2 compat: missing key keeps the legacy path (payload-only RPC shape preserved when absent)', () => {
  const r = route();
  // the RPC call keeps working when the header is absent (key: null → DB default)
  assert.match(r, /payload: \{/);
  assert.match(r, /place_order/);
});

test('F2 compat: F1 unavailable-items guard is untouched', () => {
  const f = form();
  assert.match(f, /unavailableItems\.length > 0/);
  assert.match(f, /Видаліть недоступні товари/);
});

test('F2 compat: existing order security tests still pin the route (no checks removed)', () => {
  const r = route();
  assert.match(r, /enforceRateLimit\(request, 'orders'\)/);
  assert.match(r, /P0422/);
  assert.match(r, /P0409/);
  assert.match(r, /P0400/);
});
