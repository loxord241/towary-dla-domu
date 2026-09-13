/**
 * Ukrposhta in the checkout — runtime sanitizer + static UI invariants.
 *
 * The checkout gains «Укрпошта — Відділення» (ukrposhta_warehouse) with
 * the SAME strict delivery-object contract as Nova Post: whitelisted ids
 * from a list click only, no courier branch, no money/payer fields,
 * price never chosen in the UI (the carrier tariff remains «за тарифами
 * перевізника» and the manager/carrier confirms it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { sanitizeDelivery } from '../app/lib/checkout-delivery.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
// 2026-09-13: CheckoutForm was mechanically split (parts/* + delivery-apis).
// The union is the same code the monolith held; all pins below keep their
// original force — match regexes must still hit, count regexes still count
// the same occurrences, and doesNotMatch pins now cover every split file.
const CHECKOUT_FILES = [
  'app/checkout/CheckoutForm.tsx',
  'app/checkout/delivery-apis.ts',
  'app/checkout/parts/ContactFields.tsx',
  'app/checkout/parts/DeliveryCarrierPicker.tsx',
  'app/checkout/parts/PickupBlock.tsx',
  'app/checkout/parts/NovaPostDelivery.tsx',
  'app/checkout/parts/UkrposhtaDelivery.tsx',
  'app/checkout/parts/LiqPayHint.tsx',
  'app/checkout/parts/OrderSummary.tsx',
] as const;

const FORM = CHECKOUT_FILES.map((rel) => src(rel)).join('\n');

// next/server is not resolvable under plain node:test — load the REAL
// rate-limit source with only the NextResponse import stubbed (the
// established rate-limit-xff pattern) to read the named rules.
async function loadRateRules(): Promise<Record<string, unknown>> {
  const rl = src('app/lib/rate-limit.ts')
    .replace(
      /import\s*\{\s*NextResponse\s*\}\s*from\s*'next\/server';/,
      'const NextResponse = Object;'
    )
    // the shared layer rides along (builtins resolve; supabase stays
    // dynamic and is never hit — only RATE_RULES is read here)
    .replace(/from '\.\/rate-limit-shared'/g, "from './rate-limit-shared.mts'");
  const dir = mkdtempSync(path.join(tmpdir(), 'up-rate-rules-'));
  try {
    writeFileSync(
      path.join(dir, 'rate-limit-shared.mts'),
      src('app/lib/rate-limit-shared.ts')
    );
    const file = path.join(dir, 'rate-limit-stubbed.mts');
    writeFileSync(file, rl);
    return (await import(pathToFileURL(file).href)).RATE_RULES;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------
// sanitizeDelivery with ukrposhta_warehouse
// ------------------------------------------------------------------

test('DELIVERY: ukrposhta_warehouse follows the warehouse contract', () => {
  const ok = sanitizeDelivery({
    serviceType: 'ukrposhta_warehouse',
    settlementId: 14288,
    settlementName: 'Львів',
    divisionId: 1176813,
    divisionName: 'П-т Епіцентр (1147) Львів 79155, 79155, вул. Тичини, 15',
  });
  assert.equal(ok.kind, 'ok');
  if (ok.kind === 'ok') {
    assert.equal(ok.value.serviceType, 'ukrposhta_warehouse');
    assert.equal(ok.value.settlementId, 14288);
    assert.equal(ok.value.divisionId, 1176813);
  }

  // division is mandatory (warehouse branch), ids stay strict integers
  assert.equal(
    sanitizeDelivery({
      serviceType: 'ukrposhta_warehouse',
      settlementId: 14288,
      settlementName: 'Львів',
    }).kind,
    'invalid'
  );
  assert.equal(
    sanitizeDelivery({
      serviceType: 'ukrposhta_warehouse',
      settlementId: '14288',
      settlementName: 'Львів',
      divisionId: 1176813,
    }).kind,
    'invalid'
  );
});

test('DELIVERY: there is deliberately NO ukrposhta_courier service type', () => {
  assert.equal(
    sanitizeDelivery({
      serviceType: 'ukrposhta_courier',
      settlementId: 1,
      settlementName: 'x',
      streetName: 's',
      building: '1',
    }).kind,
    'invalid'
  );
});

test('DELIVERY: money-like keys stay structurally impossible for ukrposhta rows', () => {
  assert.equal(
    sanitizeDelivery({
      serviceType: 'ukrposhta_warehouse',
      settlementId: 1,
      settlementName: 'x',
      divisionId: 1,
      cost: 100,
      payerType: 'Sender',
    }).kind,
    'invalid'
  );
});

test('DELIVERY: Nova Post service types keep working unchanged', () => {
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_warehouse',
      settlementId: 119638,
      settlementName: 'місто Кривий Ріг',
      divisionId: 11654,
    }).kind,
    'ok'
  );
  assert.equal(
    sanitizeDelivery({
      serviceType: 'nova_poshta_courier',
      settlementId: 119638,
      settlementName: 'x',
      streetName: 's',
      building: '1',
    }).kind,
    'ok'
  );
});

// ------------------------------------------------------------------
// Rate limits: conservative dedicated Ukrposhta buckets
// ------------------------------------------------------------------

test('RATE-LIMIT: ukrposhta routes have their own 12/min rules', async () => {
  const RATE_RULES = (await loadRateRules()) as Record<string, unknown>;
  for (const route of ['ukrposhtaSettlements', 'ukrposhtaOffices', 'ukrposhtaDeliveryCost']) {
    const rules = RATE_RULES[route];
    assert.ok(Array.isArray(rules) && rules.length === 1, route);
    const rule = (rules as { max: number; windowMs: number }[])[0]!;
    assert.equal(rule.max, 12, route);
    assert.equal(rule.windowMs, 60_000, route);
  }
});

// ------------------------------------------------------------------
// Static CheckoutForm invariants (additive branch)
// ------------------------------------------------------------------

test('CHECKOUT: ukrposhta_warehouse is reachable via its carrier block + service button', () => {
  // 2026-09-08: the flat 4-card grid became 2 carrier blocks with
  // per-carrier service-type buttons, so the combined «Укрпошта —
  // Відділення» card label no longer exists as such — the carrier label
  // and the service-type mapping now live in CARRIERS/CARRIER_SERVICE_TYPES.
  assert.match(FORM, /value: 'ukrposhta', label: 'Укрпошта'/);
  assert.match(FORM, /value: 'ukrposhta_warehouse', label: 'Відділення'/);
});

test('CHECKOUT: no ukrposhta courier mode anywhere in the form', () => {
  assert.doesNotMatch(FORM, /ukrposhta_courier/);
});

test('CHECKOUT: UP city/office loaders hit the dedicated /ukrposhta/* routes', () => {
  assert.match(FORM, /\/api\/delivery\/ukrposhta\/settlements\?q=/);
  assert.match(FORM, /\/api\/delivery\/ukrposhta\/offices\?cityId=/);
});

test('CHECKOUT: UP city autocomplete reuses the debounce + stale-guard mechanics', () => {
  assert.match(FORM, /upSettlementDebounceRef\.current = setTimeout/);
  assert.match(FORM, /const seq = \+\+upSettlementRequestSeq\.current/);
  const guardCount = (FORM.match(/seq !== upSettlementRequestSeq\.current\) return;/g) ?? []).length;
  assert.ok(guardCount >= 2, 'guard must cover onData AND onError callbacks');
  assert.match(FORM, /Шукаємо…/);
  assert.match(FORM, /Нічого не знайдено/);
});

test('CHECKOUT: UP delivery object mirrors the NP warehouse shape (ids only)', () => {
  // the UP branch runs BEFORE the NP gate and stores integer ids
  assert.match(FORM, /if \(deliveryType === 'ukrposhta_warehouse'\) \{[\s\S]*?if \(!upSettlement \|\| !upOffice\) return null;/);
  assert.match(FORM, /settlementId: upSettlement\.id/);
  assert.match(FORM, /divisionId: upOffice\.id/);
  // free text is never a chosen settlement: id comes only from a list click
  assert.match(FORM, /setUpSettlement\(s\)/);
});

test('CHECKOUT: switching delivery type never lets carriers share dictionary state', () => {
  // 2026-09-08: service types are now chosen inside an expanded carrier
  // block (applyServiceType(t)), but the reset contract is unchanged.
  // NP divisions are fetched only for the two NP warehouse-ish types…
  assert.match(FORM, /if \(settlement && isNpWarehouseType\(t\)\) \{/);
  // …and the UP choice is reset on every type switch
  assert.match(FORM, /resetUkrposhtaState\(\)/);
  // the NP settlement click handler is guarded too
  assert.match(FORM, /if \(deliveryType && isNpWarehouseType\(deliveryType\)\) \{/);
});

test('CHECKOUT: the order still carries «за тарифами перевізника» — no price picking', () => {
  assert.match(FORM, /за тарифами перевізника/);
  assert.doesNotMatch(FORM, /ukrposhtaDeliveryCostApi|delivery\/ukrposhta\/delivery-cost/);
});

test('CHECKOUT: the pre-payment disclaimer now describes the real LiqPay flow', () => {
  // 2026-09-12: the disclaimer is hidden when a pickup order pays cash at
  // the point (paymentIntent cash_on_pickup) — for every other path it
  // still describes the real LiqPay flow.
  assert.match(FORM, /\!\(deliveryType === 'pickup' && paymentIntent === 'cash_on_pickup'\)/);
  assert.match(
    FORM,
    /Після оформлення замовлення ви зможете одразу сплатити його\s+онлайн через LiqPay\./
  );
  assert.ok(
    !FORM.includes('з вами зв’яжеться менеджер для підтвердження та оплати'),
    'the misleading "manager will contact you for payment" line must be gone'
  );
});

test('CHECKOUT: delivery section heading is carrier-neutral now', () => {
  assert.match(FORM, /2\. Доставка/);
  assert.ok(!FORM.includes('2. Доставка (Нова Пошта)'));
});
