/**
 * CategorySelect — searchable hierarchical replacement for the 205-option
 * native <select> in the catalog filters.
 *
 * Accessibility contract (required addendum, 2026-08):
 *  - correct focus management (into the panel on open, back to the
 *    trigger on close);
 *  - Escape closes the list and RETURNS FOCUS TO THE TRIGGER;
 *  - ArrowUp/ArrowDown move the active option, Enter selects it;
 *  - aria-expanded / aria-controls / role wiring is complete;
 *  - the search field is reachable and usable from the keyboard.
 *
 * Functional contract:
 *  - hierarchy via buildCategoryOptions (paths disambiguate duplicates);
 *  - search runs against the FULL option set, not a rendered subset;
 *  - selection value stays the category slug (URL `category=...`
 *    compatibility untouched).
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

const select = () => src('app/components/CategorySelect.tsx');

// ---- aria wiring ----

test('CATEGORY-SELECT: trigger exposes aria-expanded and aria-controls', () => {
  const s = select();
  assert.match(s, /aria-expanded/, 'trigger must announce open state');
  assert.match(s, /aria-controls/, 'trigger must reference the listbox id');
});

test('CATEGORY-SELECT: options live in a role=listbox with role=option children', () => {
  const s = select();
  assert.match(s, /role="listbox"/);
  assert.match(s, /role="option"/);
  // active option must be announced through aria-activedescendant
  assert.match(s, /aria-activedescendant/, 'keyboard nav needs activedescendant');
});

test('CATEGORY-SELECT: trigger is a labelled combobox-style button', () => {
  const s = select();
  assert.match(
    s,
    /aria-haspopup="listbox"|aria-haspopup="true"/,
    'trigger must declare the popup type'
  );
  assert.match(s, /aria-label|aria-labelledby/, 'trigger needs an accessible name');
});

// ---- keyboard behaviour ----

test('CATEGORY-SELECT: Escape closes and returns focus to the trigger', () => {
  const s = select();
  assert.match(s, /Escape/, 'Escape handler missing');
  // explicit ref-driven refocus of the trigger button
  assert.match(s, /triggerRef[\s\S]*?\.focus\(\)|\.focus\(\)[\s\S]*?triggerRef/,
    'close path must restore focus to the trigger');
});

test('CATEGORY-SELECT: ArrowDown/ArrowUp navigate, Enter selects', () => {
  const s = select();
  assert.match(s, /ArrowDown/);
  assert.match(s, /ArrowUp/);
  assert.match(s, /Enter/);
  // navigation must be clamped to the rendered option range
  assert.match(s, /Math\.min\(|Math\.max\(/, 'active index must stay in bounds');
});

test('CATEGORY-SELECT: «Всі категорії» is part of the keyboard path (2026-09-04)', () => {
  const s = select();
  // The all-row is activeIndex 0: activedescendant can point AT it, Enter
  // on it clears the selection, and it carries the stable option id.
  assert.match(s, /id="category-opt-0"/, 'all-row must own activedescendant slot 0');
  assert.match(s, /activeIndex === 0[\s\S]{0,200}?onChange\(''\)/,
    'Enter on the all-row must clear the selection');
  assert.match(s, /filtered\[activeIndex - 1\]/,
    'category rows sit at activeIndex n → filtered[n-1]');
  assert.match(s, /onMouseMove=\{\(\) => setRawActiveIndex\(0\)\}/,
    'hover parity with keyboard for the all-row');
});

test('CATEGORY-SELECT: search input is a real focusable field', () => {
  const s = select();
  assert.match(s, /<input\b/, 'search must be a native input');
  assert.match(s, /type="text"|type="search"/);
  assert.match(s, /aria-label="Пошук категорій"/, 'search needs an accessible name');
});

test('CATEGORY-SELECT: focus moves into the panel when it opens', () => {
  const s = select();
  // search input receives focus on open (autofocus effect)
  assert.match(s, /searchInputRef[\s\S]*?\.focus\(\)/, 'open must focus the search field');
});

// ---- data + URL contract ----

test('CATEGORY-SELECT: builds options from the shared hierarchy helper', () => {
  const s = select();
  assert.match(s, /buildCategoryOptions/);
  assert.match(s, /filterCategoryOptions/, 'search must filter the full set');
  assert.doesNotMatch(s, /<select\b/, 'no giant native select anymore');
});

test('CATEGORY-SELECT: selection value is the slug; «Всі категорії» clears it', () => {
  const s = select();
  assert.match(s, /onChange\(\s*option\.slug\s*\)|onChange\(option\.slug\)/,
    'parent gets the slug, not the label');
  assert.match(s, /Всі категорії/, 'clear affordance kept');
});

test('CATEGORY-SELECT: duplicate names are disambiguated by branch label', () => {
  const s = select();
  assert.match(s, /option\.label/, 'list must render the full path label');
});

// ---- collapsible tree (2026-08-26) ----

test('CATEGORY-TREE: toggle arrow carries aria-expanded + aria-controls, separate from selection', () => {
  const s = select();
  assert.match(s, /expandedIds/, 'collapsible state missing');
  assert.match(s, /aria-expanded=\{[^}]*isOpen|aria-expanded=\{isExpanded\}/,
    'toggle button must announce expansion');
  assert.match(s, /aria-controls=\{[^`]*`category-kids-/, 'toggle must reference nested list');
  assert.match(s, /розгорнути\/згорнути/, 'toggle needs an accessible name distinct from selection');
});

test('CATEGORY-TREE: ArrowRight/ArrowLeft expand/collapse the active node', () => {
  const s = select();
  assert.match(s, /'ArrowRight'/);
  assert.match(s, /'ArrowLeft'/);
});

test('CATEGORY-TREE: search reveals everything; empty query honors collapsed state', () => {
  const s = select();
  assert.match(s, /query\.trim\(\)\s*===\s*''/, 'visibility must branch on search emptiness');
  assert.match(s, /buildCategoryOptions\(categories,\s*\{\s*expanded/, 'expanded set must feed the builder');
});

test('CATEGORY-TREE: URL contract untouched — selection still emits slug only', () => {
  const s = select();
  assert.match(s, /onChange\(option\.slug\)/);
});
