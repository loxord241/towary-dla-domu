/**
 * Checkout customer ПІБ + phone normalization + settlements autocomplete —
 * static invariants (migration 027, /api/orders, CheckoutForm, admin UI).
 *
 * Pins:
 *  - place_order (migration 027) accepts OPTIONAL first_name/last_name/
 *    patronymic and stores them in orders.customer_info — backward
 *    compatible with legacy `name`-only payloads;
 *  - /api/orders composes the full name server-side and enforces UA E.164
 *    for non-empty phones (strengthened, never weakened);
 *  - CheckoutForm renders Ім'я/Прізвище/По батькові, a fixed +380 prefix
 *    phone field, and a debounce + loading/empty-state settlements
 *    autocomplete that only accepts dictionary ids;
 *  - admin orders UI surfaces the structured ПІБ;
 *  - money model untouched (stage-2G pins stay green).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const MIGRATION = 'database/migrations/027_customer_names.sql';

// ---- migration 027: place_order extension ----

test('CUSTOMER-NAMES: migration 027 replaces place_order with optional ПІБ', () => {
  const m = src(MIGRATION);
  assert.match(m, /create or replace function public\.place_order\(payload jsonb\)/);
  for (const key of ['first_name', 'last_name', 'patronymic']) {
    assert.match(m, new RegExp(`payload->>'${key}'`), `payload key ${key} parsed`);
  }
  // Each part capped like the legacy name.
  assert.match(m, /length\(v_first_name\) > 120/);
  assert.match(m, /length\(v_last_name\) > 120/);
  assert.match(m, /length\(v_patronymic\) > 120/);
});

test('CUSTOMER-NAMES: legacy name-only payloads keep working', () => {
  const m = src(MIGRATION);
  // Composed ПІБ wins only when a structured part is provided…
  assert.match(m, /if v_first_name <> '' or v_last_name <> '' then/);
  // …otherwise the legacy `name` payload is used verbatim.
  assert.match(m, /v_name\s*:=\s*btrim\(coalesce\(payload->>'name', ''\)\)/);
});

test('CUSTOMER-NAMES: customer_info gains ПІБ keys only when provided', () => {
  const m = src(MIGRATION);
  assert.match(m, /jsonb_strip_nulls\(jsonb_build_object\(/);
  assert.match(m, /'first_name',\s*nullif\(v_first_name, ''\)/);
  assert.match(m, /'last_name',\s*nullif\(v_last_name, ''\)/);
  assert.match(m, /'patronymic',\s*nullif\(v_patronymic, ''\)/);
});

test('CUSTOMER-NAMES: migration 027 does not touch the money model', () => {
  const m = src(MIGRATION);
  assert.match(m, /v_subtotal, 0,/, 'shipping_total stays the constant 0');
  assert.doesNotMatch(m, /delivery_cost/i);
});

// ---- /api/orders route ----

test('CUSTOMER-NAMES: orders route parses and forwards structured ПІБ', () => {
  const r = src('app/api/orders/route.ts');
  assert.match(r, /contact\.firstName/);
  assert.match(r, /contact\.lastName/);
  assert.match(r, /contact\.patronymic/);
  assert.match(r, /first_name: firstName/);
  assert.match(r, /last_name: lastName/);
  assert.match(r, /^\s*patronymic,\s*$/m);
  // Composed name keeps the legacy contract valid.
  assert.match(r, /\[lastName, firstName, patronymic\]/);
});

test('CUSTOMER-NAMES: orders route enforces UA E.164 for non-empty phones', () => {
  const r = src('app/api/orders/route.ts');
  assert.ok(
    r.includes(String.raw`phone !== '' && !/^\+380\d{9}$/.test(phone)`),
    'non-empty phone must match UA E.164'
  );
  // Optional phone stays optional.
  assert.match(r, /if \(phone\.length > 40\)/);
});

// ---- CheckoutForm ----

// 2026-09-13 mechanical split: the contact inputs render in
// parts/ContactFields.tsx; validation + submit stay in CheckoutForm.tsx.
const CONTACT_FIELDS = 'app/checkout/parts/ContactFields.tsx';

test('CUSTOMER-FORM: three structured name fields rendered', () => {
  const f = src('app/checkout/CheckoutForm.tsx');
  const c = src(CONTACT_FIELDS);
  for (const id of ['co-first-name', 'co-last-name', 'co-patronymic']) {
    assert.match(c, new RegExp(id), `missing field ${id}`);
  }
  assert.match(c, /Ім’я \*/);
  assert.match(c, /Прізвище \*/);
  assert.match(c, /По батькові/);
  // Required: first + last; patronymic optional.
  assert.match(f, /errs\.firstName = 'Вкажіть ім’я'/);
  assert.match(f, /errs\.lastName = 'Вкажіть прізвище'/);
});

test('CUSTOMER-FORM: composed ПІБ validated against the server-side 120 cap', () => {
  const f = src('app/checkout/CheckoutForm.tsx');
  // Per-field ≤120 checks alone let a joined name exceed the server limit
  // and die on a misleading 400 — the composed length is validated locally.
  assert.match(f, /name\.length > 120/);
  assert.match(f, /разом — до 120 символів/);
});

test('CUSTOMER-FORM: phone has fixed +380 prefix and E.164 normalization', () => {
  const f = src('app/checkout/CheckoutForm.tsx');
  const c = src(CONTACT_FIELDS);
  assert.match(c, /\+380/);
  assert.match(c, /normalizeUaPhoneDigits/);
  assert.match(f, /toE164Ua/);
  // Prefix is display-only: never part of the typed value.
  assert.match(c, /aria-label="Номер телефону після \+380"/);
  // Incomplete numbers are rejected before submit.
  assert.match(f, /Вкажіть повний номер після \+380/);
});

// ---- settlements autocomplete ----

test('AUTOCOMPLETE: debounce, loading + empty states, dictionary-only ids', () => {
  // 2026-09-13 mechanical split: the NP settlement/street machinery now
  // lives in parts/NovaPostDelivery.tsx (UI) + delivery-apis.ts (loaders);
  // the union below is the same code the monolith used to hold.
  const f = [
    'app/checkout/CheckoutForm.tsx',
    'app/checkout/delivery-apis.ts',
    'app/checkout/parts/NovaPostDelivery.tsx',
    'app/checkout/parts/UkrposhtaDelivery.tsx',
  ].map(src)
    .join('\n');
  // Debounced search (~300ms within the 250-400ms window).
  assert.match(f, /}, 300\)/);
  assert.match(f, /settlementDebounceRef/);
  assert.match(f, /streetDebounceRef/, 'street timer is independent');
  assert.match(f, /setSettlementLoading\(true\)/);
  assert.match(f, /Шукаємо…/, 'loading state');
  assert.match(f, /Нічого не знайдено/, 'empty state');
  // Free text never counts as a choice: id only via list click.
  assert.match(f, /setSettlement\(s\)/);
  // Editing text after a choice resets the chosen settlement.
  assert.match(f, /setSettlementQuery\(q\);\n\s*setSettlement\(null\)/);
  // Existing API reused — no new settlements endpoint.
  assert.match(f, /\/api\/delivery\/novapost\/settlements/);
});

// ---- admin orders display ----

test('CUSTOMER-ADMIN: orders UI reads structured ПІБ from customer_info', () => {
  const a = src('app/admin/(dashboard)/orders/page.tsx');
  assert.match(a, /first_name\?/);
  assert.match(a, /last_name\?/);
  assert.match(a, /patronymic\?/);
});
