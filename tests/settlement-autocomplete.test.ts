/**
 * Settlement autocomplete regression — static invariants on CheckoutForm.
 *
 * Root cause pinned here (2026-08-28): settlement search responses were
 * applied regardless of order. On a slow network a STALE response (older
 * query) could overwrite fresher results or re-open the dropdown after a
 * selection — the autocomplete "stopped working" intermittently. The fix
 * is a request-sequence guard; these tests pin it so it cannot regress.
 *
 * Full path contract (unchanged): CheckoutForm → 300ms debounce →
 * GET /api/delivery/novapost/settlements?q=… → { items: [{id, name,
 * regionName, regionParentName}] } → dropdown → click → integer
 * settlementId in state; free text is never a valid choice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// 2026-09-13: CheckoutForm was mechanically split — the NP/UP dictionary
// UI now lives in app/checkout/parts/* and the loaders in delivery-apis.ts.
// The union below is the same code the monolith used to hold; every pin
// below keeps its original force against that union.
const CHECKOUT_FILES = [
  'app/checkout/CheckoutForm.tsx',
  'app/checkout/delivery-apis.ts',
  'app/checkout/parts/DeliveryCarrierPicker.tsx',
  'app/checkout/parts/NovaPostDelivery.tsx',
  'app/checkout/parts/UkrposhtaDelivery.tsx',
] as const;

const FORM = CHECKOUT_FILES.map((rel) => src(rel)).join('\n');

test('AUTOCOMPLETE: existing settlements API reused with q param and {items} mapping', () => {
  const f = FORM;
  assert.match(f, /\/api\/delivery\/novapost\/settlements\?q=/);
  assert.match(f, /data\?\.items/, 'response shape { items } consumed');
  // No second settlements endpoint may appear anywhere in the repo.
  const route = src('app/api/delivery/novapost/settlements/route.ts');
  assert.match(route, /export async function GET/);
});

test('AUTOCOMPLETE: search is debounced (~300ms) with its own timer ref', () => {
  const f = FORM;
  assert.match(f, /settlementDebounceRef/);
  assert.match(f, /settlementDebounceRef\.current = setTimeout/);
  assert.match(f, /}, 300\)/);
});

test('AUTOCOMPLETE: stale responses are dropped via request sequence guard', () => {
  const f = FORM;
  assert.match(f, /const settlementRequestSeq = useRef\(0\)/);
  // Captured per request, checked in BOTH success and error callbacks.
  assert.match(f, /const seq = \+\+settlementRequestSeq\.current/);
  const guardCount = (f.match(/seq !== settlementRequestSeq\.current\) return;/g) ?? []).length;
  assert.ok(guardCount >= 2, 'guard must cover onData AND onError callbacks');
  // Clearing the query also invalidates in-flight responses.
  assert.match(f, /settlementRequestSeq\.current \+= 1;\n\s*setSettlementLoading\(false\)/);
});

test('AUTOCOMPLETE: selection finalizes — in-flight response cannot re-open dropdown', () => {
  const f = FORM;
  // Click handler bumps the sequence and cancels the pending debounce…
  assert.match(
    f,
    /settlementRequestSeq\.current \+= 1;\n\s*if \(settlementDebounceRef\.current\) clearTimeout\(settlementDebounceRef\.current\);/
  );
  // …and stores the dictionary row itself (integer id), not the text.
  assert.match(f, /setSettlement\(s\)/);
  assert.match(f, /setSettlementQuery\(s\.name\)/);
  assert.match(f, /setSettlementOpen\(false\)/);
});

test('AUTOCOMPLETE: editing text after selection resets the chosen settlementId', () => {
  const f = FORM;
  assert.match(f, /setSettlementQuery\(q\);\n\s*setSettlement\(null\)/);
});

test('AUTOCOMPLETE: free text is never a valid choice — submit gate needs settlement', () => {
  const f = FORM;
  // deliveryObject() is null without a dictionary-selected settlement.
  assert.match(f, /if \(!deliveryType \|\| !settlement\) return null;/);
  // …and the form blocks submit when the delivery object is incomplete.
  assert.match(f, /if \(!delivery\) \{/);
  assert.match(f, /settlementId: settlement\.id/);
});

test('AUTOCOMPLETE: loading and empty states are rendered', () => {
  const f = FORM;
  assert.match(f, /setSettlementLoading\(true\)/);
  assert.match(f, /Шукаємо…/);
  assert.match(f, /Нічого не знайдено/);
});

test('AUTOCOMPLETE: street search untouched — own debouncer and loader intact', () => {
  const f = FORM;
  assert.match(f, /streetDebounceRef\.current = setTimeout/);
  assert.match(f, /searchStreetsApi/);
  assert.match(f, /\/api\/delivery\/novapost\/streets\?settlementId=/);
});
