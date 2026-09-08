/**
 * Checkout carrier-select contract (2026-09 redesign).
 *
 * The flat 4-card delivery grid («Нова Пошта — Відділення / — Поштомат /
 * — Кур’єр / Укрпошта — Відділення») was replaced by 2 carrier blocks
 * («Нова Пошта», «Укрпошта»); clicking a block reveals its service-type
 * buttons directly underneath. Static pins (node:test cannot mount JSX —
 * the established CheckoutForm pattern):
 *
 *   - exactly 2 carrier blocks;
 *   - Nova Post sub-buttons map exactly to
 *     nova_poshta_{warehouse,locker,courier}, Ukrposhta — to
 *     ukrposhta_warehouse (sanitizeDelivery contract untouched);
 *   - sub-buttons render ONLY under the expanded carrier;
 *   - the sub-row disclosure animates via the CSS grid-rows trick
 *     (always-mounted wrapper, 0fr/1fr + visibility transition,
 *     motion-reduce safe, collapsed buttons unfocusable);
 *   - a carrier switch/collapse resets the previous carrier's dependent
 *     state (deliveryType + city/office/street/address) — carriers can
 *     never mix in one delivery object.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORM = readFileSync(
  path.join(root, 'app/checkout/CheckoutForm.tsx'),
  'utf8'
);

/** Body of a `const NAME = (...) => { … };` member of CheckoutForm. */
function fnBody(name: string): string {
  const start = FORM.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `handler ${name} must exist`);
  const end = FORM.indexOf('\n  };', start);
  assert.notEqual(end, -1, `handler ${name} must close`);
  return FORM.slice(start, end);
}

// ------------------------------------------------------------------
// Exactly 2 carrier blocks
// ------------------------------------------------------------------

test('CARRIER: exactly two carrier blocks — Нова Пошта and Укрпошта', () => {
  const start = FORM.indexOf('const CARRIERS');
  const end = FORM.indexOf('];', start);
  const carriers = FORM.slice(start, end);
  assert.match(carriers, /value: 'nova_poshta', label: 'Нова Пошта'/);
  assert.match(carriers, /value: 'ukrposhta', label: 'Укрпошта'/);
  // exactly two entries, no others
  assert.equal((carriers.match(/value: '/g) ?? []).length, 2);
  // a single render site drives both blocks
  assert.equal((FORM.match(/toggleCarrier\(c\.value\)/g) ?? []).length, 1);
});

// ------------------------------------------------------------------
// Sub-button → service_type mapping
// ------------------------------------------------------------------

test('CARRIER: Nova Post sub-buttons map exactly to warehouse/locker/courier', () => {
  const start = FORM.indexOf('const CARRIER_SERVICE_TYPES');
  const end = FORM.indexOf('\n};', start);
  const mapping = FORM.slice(start, end);
  const np = mapping.slice(mapping.indexOf('nova_poshta: ['), mapping.indexOf('ukrposhta: ['));
  const up = mapping.slice(mapping.indexOf('ukrposhta: ['));
  assert.match(np, /value: 'nova_poshta_warehouse', label: 'Відділення'/);
  assert.match(np, /value: 'nova_poshta_locker', label: 'Поштомат'/);
  assert.match(np, /value: 'nova_poshta_courier', label: 'Кур’єр'/);
  assert.equal((np.match(/value: '/g) ?? []).length, 3, 'NP has exactly 3 service types');
  // Ukrposhta exposes exactly one service type
  assert.match(up, /value: 'ukrposhta_warehouse', label: 'Відділення'/);
  assert.equal((up.match(/value: '/g) ?? []).length, 1, 'UP has exactly 1 service type');
  // the 4 service_types are unchanged (sanitizeDelivery contract)
  assert.doesNotMatch(FORM, /ukrposhta_courier/);
});

// ------------------------------------------------------------------
// Sub-buttons live under the expanded carrier only
// ------------------------------------------------------------------

test('CARRIER: service buttons render ONLY under the selected carrier, below it', () => {
  const btn = FORM.indexOf('aria-pressed={selected}'); // carrier button
  // 2026-09 animation rework: the sub-row wrapper is always mounted (CSS
  // grid-rows disclosure). "Only under the selected carrier" is now the
  // expanded/collapsed class pair on `#carrier-services-*`, not a
  // conditional `{selected && (…)` render.
  const wrapper = FORM.indexOf('grid-rows-[0fr] invisible');
  const expanded = FORM.indexOf('grid-rows-[1fr] visible');
  const row = FORM.indexOf('CARRIER_SERVICE_TYPES[c.value].map');
  assert.ok(
    btn !== -1 && wrapper !== -1 && expanded !== -1 && row !== -1
  );
  // ternary order in the className: expanded branch is written first
  assert.ok(
    btn < expanded && expanded < wrapper && wrapper < row,
    'sub-row must be gated on the selected carrier'
  );
  // "немного ниже" the block: margin-top on the sub-row
  assert.match(FORM, /className="mt-2 flex flex-wrap gap-2"/);
});

// ------------------------------------------------------------------
// Disclosure animation (grid-rows trick, no JS measurement)
// ------------------------------------------------------------------

test('CARRIER: sub-row disclosure animates via grid-rows, keyboard-safe when collapsed', () => {
  // wrapper animates grid-template-rows AND visibility
  assert.match(
    FORM,
    /transition-\[grid-template-rows,visibility\] duration-200 ease-out/,
    'smooth open/close transition classes on the wrapper'
  );
  // project pattern: animations disabled for prefers-reduced-motion
  const wrapperStart = FORM.indexOf(
    'grid transition-[grid-template-rows,visibility]'
  );
  assert.notEqual(wrapperStart, -1, 'always-mounted wrapper must exist');
  const wrapper = FORM.slice(
    wrapperStart,
    FORM.indexOf('<div className="min-h-0 overflow-hidden">')
  );
  assert.match(wrapper, /motion-reduce:transition-none/);
  // collapsed: 0fr + visibility:hidden (out of tab order / a11y tree)
  assert.match(wrapper, /selected\s*\?\s*'grid-rows-\[1fr\] visible'/);
  assert.match(wrapper, /:\s*'grid-rows-\[0fr\] invisible'/);
  // inner row clips content and may shrink to zero
  assert.match(FORM, /<div className="min-h-0 overflow-hidden">/);
});

// ------------------------------------------------------------------
// Reset contract: carriers never share dependent state
// ------------------------------------------------------------------

test('CARRIER: carrier switch/collapse resets the previous carrier state fully', () => {
  const toggle = fnBody('toggleCarrier');
  assert.match(toggle, /resetCarrierChoice\(\)/, 'toggle must run the carrier reset');
  assert.match(toggle, /setCarrier\(carrier === next \? '' : next\)/);

  const carrierReset = fnBody('resetCarrierChoice');
  assert.match(carrierReset, /resetServiceChoice\(\)/);
  // …plus the NP city search state of the previous carrier
  assert.match(carrierReset, /settlementRequestSeq\.current \+= 1/);
  assert.match(carrierReset, /clearTimeout\(settlementDebounceRef\.current\)/);
  assert.match(carrierReset, /setSettlement\(null\)/);
  assert.match(carrierReset, /setSettlementQuery\(''\)/);
  assert.match(carrierReset, /setSettlementResults\(\[\]\)/);
  assert.match(carrierReset, /setSettlementLoading\(false\)/);
});

test('CARRIER: service-type choice resets divisions/streets/address + UP state', () => {
  const reset = fnBody('resetServiceChoice');
  assert.match(reset, /setDeliveryType\(''\)/);
  // NP dependent choices
  assert.match(reset, /setDivision\(null\)/);
  assert.match(reset, /setStreet\(null\)/);
  assert.match(reset, /setBuilding\(''\)/);
  assert.match(reset, /setFlat\(''\)/);
  assert.match(reset, /setDivisions\(\[\]\)/);
  assert.match(reset, /divisionsRequestSeq\.current \+= 1/);
  assert.match(reset, /streetRequestSeq\.current \+= 1/);
  // UP dependent choices — carriers never mix dictionaries
  assert.match(reset, /resetUkrposhtaState\(\)/);
  assert.match(reset, /setDeliveryError\(null\)/);
});

test('CARRIER: picking a service type goes through the reset + strict gates', () => {
  const apply = fnBody('applyServiceType');
  assert.match(apply, /resetServiceChoice\(\)/);
  assert.match(apply, /setDeliveryType\(t\)/);
  assert.match(apply, /if \(settlement && isNpWarehouseType\(t\)\) \{/);
  // the strict delivery-object gate is untouched
  assert.match(FORM, /if \(!deliveryType \|\| !settlement\) return null;/);
});

// ------------------------------------------------------------------
// Presentation contract
// ------------------------------------------------------------------

test('CARRIER: accessible toggles with visible selection, motion-reduce safe', () => {
  // carrier block: pressed + expanded disclosure
  assert.match(FORM, /aria-pressed=\{selected\}/);
  assert.match(FORM, /aria-expanded=\{selected\}/);
  // service button: pressed
  assert.match(FORM, /aria-pressed=\{deliveryType === t\.value\}/);
  // transitions are color-only and disabled for prefers-reduced-motion
  assert.match(FORM, /transition-colors motion-reduce:transition-none/);
  // visible selection styling reuses the card/blue accents
  assert.match(FORM, /border-blue-600 ring-1 ring-blue-600/);
});

test('CARRIER: the old flat radio grid is gone; the section heading stays', () => {
  assert.doesNotMatch(FORM, /DELIVERY_TYPES/);
  assert.doesNotMatch(FORM, /name="deliveryType"/);
  assert.match(FORM, /2\. Доставка/);
});
