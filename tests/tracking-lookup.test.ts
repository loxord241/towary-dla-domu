/**
 * Guest parcel tracking + lookup UX + manual TTN (owner 2026-09-13).
 *
 * Covers:
 *   - order-tracking.ts unit: tracking deep links (Nova Post / Ukrposhta),
 *     human-readable carrier labels, TTN format, carrier↔service_type
 *     pairing (migration 038 rule);
 *   - manual TTN payload validation unit (parseManualTtnPayload);
 *   - static pins: guest order page tracking block (renders ONLY with a
 *     non-empty ttn_number, column-whitelisted read via service client),
 *     lookup auto-redirect + help phone, manual-ttn route guards
 *     (requireAdminApi, order_id+shipment_id filter, planned+no-TTN atomic
 *     guard, TTN format), admin planner form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const {
  TTN_NUMBER_RE,
  carrierLabel,
  trackingUrl,
  carrierServiceTypePairingOk,
} = await import(
  pathToFileURL(path.join(root, 'app/lib/order-tracking.ts')).href
);
const { parseManualTtnPayload } = await import(
  pathToFileURL(path.join(root, 'app/lib/admin-shipments-manual-ttn.ts')).href
);

const UUID_A = '11111111-1111-1111-1111-111111111111';

// ------------------------------------------------------- tracking unit ----

test('TRACKING: Nova Post deep links for warehouse and courier service types', () => {
  for (const st of ['nova_poshta_warehouse', 'nova_poshta_courier']) {
    assert.equal(
      trackingUrl(st, 'nova_poshta', '59001234567890'),
      'https://tracking.novaposhta.ua/#/?number=59001234567890'
    );
  }
});

test('TRACKING: Ukrposhta deep link uses the official track.ukrposhta.ua page', () => {
  assert.equal(
    trackingUrl('ukrposhta_warehouse', 'ukrposhta', 'RR123456789UA'),
    'https://track.ukrposhta.ua/tracking-uk/?ttn=RR123456789UA'
  );
  // carrier column wins as a fallback for unknown service types
  assert.equal(
    trackingUrl('something_else', 'ukrposhta', 'RR123456789UA'),
    'https://track.ukrposhta.ua/tracking-uk/?ttn=RR123456789UA'
  );
});

test('TRACKING: no link without a valid TTN or an unknown carrier', () => {
  assert.equal(trackingUrl('nova_poshta_warehouse', 'nova_poshta', ''), null);
  assert.equal(trackingUrl('nova_poshta_warehouse', 'nova_poshta', '  '), null);
  // unknown service type AND null/unknown carrier → no link
  assert.equal(trackingUrl('mystery_service', null, '59001234567890'), null);
  assert.equal(trackingUrl('mystery_service', 'dhl', '59001234567890'), null);
  // unsafe TTN shapes never reach a URL (injection surface)
  assert.equal(trackingUrl('nova_poshta_warehouse', 'nova_poshta', 'AB;alert(1)'), null);
});

test('TRACKING: carrier labels are human-readable Ukrainian', () => {
  assert.equal(carrierLabel('nova_poshta_warehouse', 'nova_poshta'), 'Нова Пошта');
  assert.equal(carrierLabel('nova_poshta_courier', 'nova_poshta'), 'Нова Пошта');
  assert.equal(carrierLabel('ukrposhta_warehouse', 'ukrposhta'), 'Укрпошта');
  // service_type wins over a stale carrier column
  assert.equal(carrierLabel('ukrposhta_warehouse', 'nova_poshta'), 'Укрпошта');
  assert.equal(carrierLabel('nova_poshta_warehouse', 'ukrposhta'), 'Нова Пошта');
  assert.equal(carrierLabel('mystery', null), '');
});

test('TRACKING: pairing rule mirrors migration 038 (ukrposhta ⇔ ukrposhta_warehouse)', () => {
  assert.equal(carrierServiceTypePairingOk('ukrposhta', 'ukrposhta_warehouse'), true);
  assert.equal(carrierServiceTypePairingOk('nova_poshta', 'nova_poshta_warehouse'), true);
  assert.equal(carrierServiceTypePairingOk('nova_poshta', 'nova_poshta_courier'), true);
  assert.equal(carrierServiceTypePairingOk('ukrposhta', 'nova_poshta_warehouse'), false);
  assert.equal(carrierServiceTypePairingOk('nova_poshta', 'ukrposhta_warehouse'), false);
});

// ------------------------------------------------------------ TTN format --

test('TTN FORMAT: 5–20 chars, letters/digits/hyphens only', () => {
  assert.equal(TTN_NUMBER_RE.test('59001234567890'), true); // Nova Post 14 digits
  assert.equal(TTN_NUMBER_RE.test('RR123456789UA'), true);   // Ukrposhta barcode
  assert.equal(TTN_NUMBER_RE.test('AB-1234-CD'), true);      // hyphens allowed
  assert.equal(TTN_NUMBER_RE.test('1234'), false);           // too short
  assert.equal(TTN_NUMBER_RE.test('A'.repeat(21)), false);   // too long
  assert.equal(TTN_NUMBER_RE.test('ТТН12345'), false);       // non-latin
  assert.equal(TTN_NUMBER_RE.test('AB 12345'), false);       // spaces
  assert.equal(TTN_NUMBER_RE.test('AB;12345'), false);       // punctuation
  assert.equal(TTN_NUMBER_RE.test(''), false);
});

// ------------------------------------------------ manual TTN payload unit --

test('MANUAL TTN: payload parser accepts a valid request', () => {
  const parsed = parseManualTtnPayload({
    shipment_id: UUID_A,
    ttn_number: '  RR123456789UA ',
    carrier: 'ukrposhta',
  });
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.payload.shipment_id, UUID_A);
    assert.equal(parsed.payload.ttn_number, 'RR123456789UA');
    assert.equal(parsed.payload.carrier, 'ukrposhta');
  }
});

test('MANUAL TTN: payload parser rejects malformed shapes with readable errors', () => {
  for (const [bad, fragment] of [
    [null, 'запит'],
    ['junk', 'запит'],
    [{ ttn_number: 'RR123456789UA', carrier: 'ukrposhta' }, 'id відправлення'],
    [{ shipment_id: 'not-a-uuid', ttn_number: 'RR123456789UA', carrier: 'ukrposhta' }, 'id відправлення'],
    [{ shipment_id: UUID_A, ttn_number: '1234', carrier: 'ukrposhta' }, 'ТТН'],
    [{ shipment_id: UUID_A, ttn_number: 'RR 123456789', carrier: 'ukrposhta' }, 'ТТН'],
    [{ shipment_id: UUID_A, ttn_number: null, carrier: 'ukrposhta' }, 'ТТН'],
    [{ shipment_id: UUID_A, ttn_number: 'RR123456789UA', carrier: 'dhl' }, 'перевізник'],
    [{ shipment_id: UUID_A, ttn_number: 'RR123456789UA' }, 'перевізник'],
  ] as [unknown, string][]) {
    const parsed = parseManualTtnPayload(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
    if (!parsed.ok) assert.match(parsed.error, new RegExp(fragment));
  }
});

// -------------------------------------------------- guest order page pins --

const ORDER_PAGE = src('app/orders/[orderNumber]/page.tsx');

test('TRACKING PAGE: order_shipments read is whitelisted, scoped, after token verify', () => {
  const verifyAt = ORDER_PAGE.indexOf('verifyOrderAccessToken(orderNumber, t)');
  const shipmentsAt = ORDER_PAGE.indexOf(".from('order_shipments')");
  assert.ok(shipmentsAt > verifyAt, 'shipment read must come after token verification');
  assert.match(ORDER_PAGE, /\.select\('service_type, carrier, ttn_number'\)/,
    'explicit column whitelist, no select *');
  assert.match(ORDER_PAGE, /\.eq\('order_id', orderData\.id\)/);
  assert.match(ORDER_PAGE, /SUPABASE_SERVICE_ROLE_KEY/,
    'guest page reads via the service-role server client (anon SELECT revoked)');
});

test('TRACKING PAGE: block renders only with a TTN and carries carrier links', () => {
  assert.match(ORDER_PAGE, /Відстеження посилки/);
  assert.match(ORDER_PAGE, /Відстежити на сайті перевізника/);
  assert.match(ORDER_PAGE, /font-mono/, 'TTN shown in a mono font');
  // conditional render: the whole block is gated on the filtered rows
  assert.match(ORDER_PAGE, /trackingRows\.length > 0 && \(/);
  // rows without a non-empty ttn_number are dropped before render
  const filterIdx = ORDER_PAGE.indexOf(".filter((r) => r.ttn !== '' && r.url !== null)");
  assert.ok(filterIdx > ORDER_PAGE.indexOf('trackingRows'), 'ttn filter precedes render');
  assert.match(ORDER_PAGE, /carrierLabel\(s\.service_type/);
  assert.match(ORDER_PAGE, /trackingUrl\(s\.service_type/);
  assert.match(ORDER_PAGE, /rel="noopener noreferrer"/, 'external carrier link hardening');
});

// ---------------------------------------------------------- lookup page ----

const LOOKUP_PAGE = src('app/orders/lookup/page.tsx');

test('LOOKUP: success redirects straight to the order view with a short status', () => {
  assert.match(LOOKUP_PAGE, /router\.push\(\s*`\/orders\/\$\{encodeURIComponent\(data\.orderNumber\)\}\?t=\$\{data\.accessToken\}`/);
  assert.match(LOOKUP_PAGE, /Замовлення знайдено — відкриваємо…/);
  assert.match(LOOKUP_PAGE, /setFound\(true\)/, 'status is set before the navigation');
  // no intermediate link screen: no <Link> to the order view built by hand
  assert.ok(!LOOKUP_PAGE.includes('Перейти до замовлення'),
    'success must auto-navigate, not show a link to click');
});

test('LOOKUP: header + help phone + mobile input contract', () => {
  assert.match(LOOKUP_PAGE, /Статус замовлення/);
  assert.match(LOOKUP_PAGE, /tel:\+380973144221/);
  assert.match(LOOKUP_PAGE, /\+380 \(97\) 314 42 21/);
  // mobile contract: touch-friendly inputs
  assert.match(LOOKUP_PAGE, /min-h-\[44px\]/);
  assert.match(LOOKUP_PAGE, /text-base/);
  // landmark invariant: exactly one <main>
  assert.equal((LOOKUP_PAGE.match(/<main/g) ?? []).length, 1);
});

// ------------------------------------------------------ manual-ttn route ---

const MANUAL_TTN_ROUTE = src(
  'app/api/admin/orders/[id]/shipments/manual-ttn/route.ts'
);

test('MANUAL TTN ROUTE: admin guard + uuid guards on the order id', () => {
  assert.match(MANUAL_TTN_ROUTE, /const ctx = await requireAdminApi\(\)/);
  assert.match(MANUAL_TTN_ROUTE, /if \(ctx instanceof NextResponse\) return ctx;/);
  assert.match(MANUAL_TTN_ROUTE, /isUuid\(id\)/);
  assert.match(MANUAL_TTN_ROUTE, /POST/);
  assert.doesNotMatch(MANUAL_TTN_ROUTE, /export async function GET/);
});

test('MANUAL TTN ROUTE: UPDATE is filtered by order_id + shipment_id + planned + no TTN', () => {
  const updateIdx = MANUAL_TTN_ROUTE.indexOf(".update({ ttn_number: ttnNumber, carrier, status: 'created' })");
  assert.ok(updateIdx !== -1, 'update sets ttn_number, carrier, status=created');
  const tail = MANUAL_TTN_ROUTE.slice(updateIdx);
  assert.match(tail, /\.eq\('id', shipmentId\)/, 'scoped to the shipment');
  assert.match(tail, /\.eq\('order_id', id\)/,
    'order_id filter — a foreign order shipment can never be touched');
  assert.match(tail, /\.eq\('status', 'planned'\)/, 'only planned rows are attached');
  assert.match(tail, /\.is\('ttn_number', null\)/,
    'an existing TTN is never overwritten');
  assert.match(tail, /\.select\('id'\)/, 'rows-affected check for the 409 path');
  assert.match(MANUAL_TTN_ROUTE, /\{ ok: true, ttn_number: ttnNumber \}/);
});

test('MANUAL TTN ROUTE: validates format and carrier↔service_type pairing', () => {
  assert.match(MANUAL_TTN_ROUTE, /parseManualTtnPayload\(body\)/);
  assert.match(MANUAL_TTN_ROUTE, /carrierServiceTypePairingOk\(carrier, shipment\.service_type\)/,
    'pairing is checked before the UPDATE (DB CHECK would 500)');
  // the parser lib owns the format, the route re-exports nothing — pin the
  // regex source lives in the pure lib
  assert.match(src('app/lib/order-tracking.ts'), /\/\^\[A-Za-z0-9-\]\{5,20\}\$\//);
});

// ----------------------------------------------------- admin planner form --

const ADMIN_PAGE = src('app/admin/(dashboard)/orders/[id]/page.tsx');

test('ADMIN PLANNER: compact manual TTN form per planned shipment', () => {
  assert.match(ADMIN_PAGE, /Ввести ТТН вручну/);
  assert.match(ADMIN_PAGE, /Прикріпити/);
  assert.match(ADMIN_PAGE, /manual-ttn/,
    'posts to the dedicated manual-ttn route');
  assert.match(ADMIN_PAGE, /maxLength=\{20\}/);
  assert.match(ADMIN_PAGE, /TTN_NUMBER_RE\.test\(ttn\)/,
    'client-side format check before the POST');
  // form shows only for planned shipments without a TTN
  assert.match(
    ADMIN_PAGE,
    /shipment\.status === 'planned' && !shipment\.ttn_number && \(/,
    'form gated on planned + no ttn'
  );
  // default carrier follows the service type (migration 038 pairing)
  assert.match(ADMIN_PAGE, /defaultCarrierFor\(shipment\.service_type\)/);
  // reload authoritative state after attach
  assert.match(ADMIN_PAGE, /fetchPlanApi\(orderId, applyData, setError, \(\) => setManualTtnBusy\(null\)\)/);
  // mobile contract
  assert.match(ADMIN_PAGE, /min-h-\[44px\] px-4 bg-indigo-600/);
});

test('ADMIN PLANNER: rollback offered only for provider-created TTNs (ttn_ref)', () => {
  // manual rows have no ttn_ref — the Nova Post DELETE rollback must not
  // even be offered for them
  const btnIdx = ADMIN_PAGE.indexOf('Скасувати ТТН');
  assert.ok(btnIdx !== -1);
  const condIdx = ADMIN_PAGE.indexOf('shipment.ttn_ref &&');
  assert.ok(condIdx !== -1 && condIdx < btnIdx);
  assert.match(src('app/api/admin/orders/[id]/shipments/route.ts'), /ttn_number, ttn_ref, delivery_cost/,
    'GET projection exposes ttn_ref for the client-side gate');
});


test('SHIPMENTS API: shipment-item embeds are FK-disambiguated (PGRST201 regression)', () => {
  // The fk-fix migration added a composite FK (shipment_id, order_id) →
  // order_shipments, which made the bare order_shipment_items embed
  // ambiguous (PostgREST 300 → the planner page answered 500).
  const plan = src('app/api/admin/orders/[id]/shipments/route.ts');
  assert.match(
    plan,
    /order_shipment_items!order_shipment_items_shipment_id_fkey\(order_item_id, quantity\)/
  );
  const ttn = src('app/api/admin/orders/[id]/shipments/ttn/route.ts');
  assert.match(
    ttn,
    /order_shipment_items!order_shipment_items_shipment_id_fkey\(quantity, order_items!fk_order_shipment_items_item_order\(product_name\)\)/
  );
});
