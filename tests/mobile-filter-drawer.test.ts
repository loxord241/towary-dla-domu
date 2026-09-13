/**
 * Mobile filter drawer for /catalog (2026-08 UX stage).
 *
 * Contract: on mobile the always-rendered filter block is replaced by a
 * «Фільтри» button opening a right-side sheet built on the NavDrawer
 * mechanics (portal, CSS transition, focus trap, scroll lock). Desktop
 * keeps the existing always-open sidebar. All close paths survive:
 * ✕ button, overlay click, Escape, and a successful apply. Applying
 * preserves q+sort and resets page (app/lib/filter-url.ts); reset clears
 * the filters but keeps the search term too (Audit 2026-09-05 — same
 * buildFilterUrl contract, empty draft). Browser Back/Forward keep
 * working because navigation stays plain router.push over URL state.
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

// ---- mobile trigger ----

test('FILTERS: mobile toggle is a labelled button with an active-count badge', () => {
  const f = filters();
  assert.match(f, /Фільтри/, 'toggle label present');
  assert.match(f, /activeCount > 0 &&[\s\S]*?rounded-full/,
    'badge renders only when count > 0');
  assert.match(f, /aria-expanded/, 'toggle announces open state');
});

// ---- drawer mechanics (NavDrawer reference) ----

test('FILTERS: sheet uses dialog semantics inside a body portal', () => {
  const f = filters();
  assert.match(f, /createPortal/);
  assert.match(f, /role="dialog"/);
  assert.match(f, /aria-modal="true"/);
  assert.match(f, /aria-label="Фільтри"/);
});

test('FILTERS: all four close paths are wired', () => {
  const f = filters();
  assert.match(f, /Escape/, 'Escape closes');
  assert.match(f, /aria-label="Закрити фільтри"/, '✕ button closes');
  assert.match(f, /onClick=\{onClose\}/, 'overlay click closes');
  // successful apply navigates AND closes
  assert.match(f, /applyFilters[\s\S]*?onClose\(\)|onClose\(\)[\s\S]*?applyFilters/,
    'apply must close the sheet');
});

test('FILTERS: scroll lock + focus management like the nav drawer', () => {
  const f = filters();
  assert.match(f, /overflow\s*=\s*'hidden'|style\.overflow = 'hidden'/,
    'body scroll locked while open');
  assert.match(f, /\.focus\(\)/, 'focus is moved/restored programmatically');
  assert.match(f, /previouslyFocused/, 'focus returns to the opener');
  assert.match(f, /keydown|onKeyDown/i, 'keyboard handling present');
});

test('FILTERS: animation follows the drawer contract with reduced-motion fallback', () => {
  const f = filters();
  assert.match(f, /transition-transform/);
  assert.match(f, /translate-x-full/);
  assert.ok((f.match(/motion-reduce:/g) ?? []).length >= 2,
    'panel AND overlay need motion-reduce fallbacks');
  assert.doesNotMatch(f, /\{open && <[\w]+Panel/, 'no instant unmount on close');
});

test('FILTERS: touch-friendly controls', () => {
  const f = filters();
  assert.match(f, /min-h-\[44px\]|min-h-11/, '44px targets on touch controls');
});

// ---- form parity + URL semantics ----

test('FILTERS: every existing filter survives in the shared form', () => {
  const f = filters();
  assert.match(f, /Категорії/);
  assert.match(f, /Бренди/);
  assert.match(f, /Ціна \(UAH\)/);
  assert.match(f, /Тільки в наявності/);
  assert.match(f, /Застосувати/);
  assert.match(f, /Скинути/);
});

test('FILTERS: apply preserves q+sort via buildFilterUrl; reset keeps q too', () => {
  const f = filters();
  assert.match(f, /buildFilterUrl/, 'URL building extracted to the tested pure module');
  // useSearchParams so apply can see q/sort of the CURRENT view
  assert.match(f, /useSearchParams/);
  // Audit 2026-09-05: reset clears the FILTERS but preserves the search
  // term — the old bare /catalog push silently dropped q.
  assert.match(f, /buildFilterUrl\(searchParams, \{\}\)/,
    'reset routes through the shared contract with an empty draft');
});

test('FILTERS: desktop sidebar keeps its always-open md:block behaviour', () => {
  const f = filters();
  assert.match(f, /md:block/, 'desktop panel stays visible without JS toggles');
  assert.match(f, /hidden md:flex|md:hidden/, 'mobile-only trigger stays mobile-only');
});

// ---- catalog page regression surface ----

test('FILTERS: catalog page still parses every legacy query param', () => {
  // The parser lives in the shared renderer since 2026-09-13.
  const page = src('app/catalog/CatalogView.tsx');
  for (const key of ['category', 'brand', 'q', 'min', 'max', 'stock', 'sort', 'page']) {
    assert.match(
      page,
      new RegExp(`raw\\.${key}\\b`),
      `catalog view must keep reading ${key}`
    );
  }
});
