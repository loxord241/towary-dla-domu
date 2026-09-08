/**
 * Brand combobox for the catalog filters (2026-09-08).
 *
 * The brand filter switched from a native <select> (huge unsearchable
 * list; a full-screen system picker on phones) to the shared
 * FilterCombobox — the same searchable trigger/panel as the category
 * tree. Contract:
 *  - the native <select> is GONE from CatalogFilters;
 *  - the brand combobox renders with «Бренд» naming and its own DOM
 *    namespace (`brand-listbox`, `brand-opt-*`);
 *  - options are a flat uk-alphabetical slug/name list (URL ?brand=
 *    contract untouched, zero new data reads);
 *  - search filters options; the reset row («Всі бренди», value '') is
 *    part of the shared panel;
 *  - the panel keeps the dropdown-in entry animation with a
 *    motion-reduce opt-out and ≥40px touch rows (mobile sheet).
 *
 * JSX is not executable in node:test (established pattern) → source
 * invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const filters = () => src('app/catalog/CatalogFilters.tsx');
const combo = () => src('app/components/FilterCombobox.tsx');

test('BRAND-COMBOBOX: the native <select> is gone from the catalog filters', () => {
  assert.doesNotMatch(
    filters(),
    /<select\b/,
    'brand native select must be fully removed'
  );
});

test('BRAND-COMBOBOX: brand field renders the shared combobox with «Бренд» naming', () => {
  const f = filters();
  assert.match(f, /<FilterCombobox/, 'brand field must use FilterCombobox');
  assert.match(f, /label="Бренд"/, 'trigger accessible-name prefix');
  assert.match(f, /idPrefix="brand"/, 'own DOM namespace: brand-listbox / brand-opt-*');
  assert.match(f, /allLabel="Всі бренди"/, 'reset row label');
  // the generic trigger composes its accessible name from the label prop
  assert.match(
    combo(),
    /aria-label=\{`\$\{label\}: /,
    'trigger aria-label must derive from the label prop («Бренд: …»)'
  );
});

test('BRAND-COMBOBOX: options are a flat alphabetical slug/name list', () => {
  const f = filters();
  assert.match(f, /localeCompare\([a-z.]+, ?'uk'\)/,
    'uk-alphabetical ordering, deterministic regardless of DB collation');
  assert.match(f, /value: b\.slug/, 'options carry the brand slug (URL ?brand= contract)');
  assert.match(f, /label: b\.name/, 'options carry the brand name');
});

test('BRAND-COMBOBOX: search filters options; reset row is present', () => {
  const c = combo();
  // array-form options are filtered by label inside the combobox
  assert.match(c, /\.filter\(\(o\) => o\.label\.toLowerCase\(\)\.includes\(needle\)\)/,
    'default label filtering for array-form options');
  assert.match(c, /allLabel/, 'reset row is rendered from the allLabel prop');
  assert.match(c, /onChange\(''\)/, 'reset row reports the empty value');
});

test('BRAND-COMBOBOX: shared panel keeps dropdown-in + motion-reduce and 40px touch rows', () => {
  const c = combo();
  assert.match(
    c,
    /className="dropdown-in[^"]*motion-reduce:animate-none[^"]*"/,
    'entry animation with reduced-motion fallback'
  );
  assert.match(
    c,
    /<div className="dropdown-in[^"]*absolute z-20/,
    'animation belongs to the absolute-positioned panel'
  );
  assert.match(c, /rounded-xl[^"]*shadow-lg/, 'polished shared panel surface');
  assert.match(c, /min-h-\[40px\]/, 'touch targets must be ≥40px tall');
});

test('BRAND-COMBOBOX: empty brands state stays «Бренди відсутні»', () => {
  assert.match(filters(), /Бренди відсутні/);
});
