/**
 * CategorySelect — searchable hierarchical picker for the catalog filters.
 *
 * 2026-09-08 refactor: the combobox mechanics (trigger, absolute panel,
 * search field, keyboard navigation, entry animation) moved into the
 * shared FilterCombobox (app/components/FilterCombobox.tsx), which now
 * also powers the brand filter. CategorySelect is a thin tree adapter.
 * These pins therefore read BOTH sources:
 *  - `select()` — category-specific semantics (tree, collapse, slugs);
 *  - `combo()`  — generic trigger/panel/a11y/keyboard contract shared with
 *    the brand combobox.
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
// 2026-09-08: generic combobox shared by categories + brands.
const combo = () => src('app/components/FilterCombobox.tsx');

// ---- aria wiring ----

test('CATEGORY-SELECT: trigger exposes aria-expanded and aria-controls', () => {
  const c = combo();
  assert.match(c, /aria-expanded/, 'trigger must announce open state');
  assert.match(c, /aria-controls/, 'trigger must reference the listbox id');
});

test('CATEGORY-SELECT: options live in a role=listbox with role=option children', () => {
  const c = combo();
  assert.match(c, /role="listbox"/);
  assert.match(c, /role="option"/);
  // active option must be announced through aria-activedescendant
  assert.match(c, /aria-activedescendant/, 'keyboard nav needs activedescendant');
});

test('CATEGORY-SELECT: trigger is a labelled combobox-style button', () => {
  const c = combo();
  assert.match(
    c,
    /aria-haspopup="listbox"|aria-haspopup="true"/,
    'trigger must declare the popup type'
  );
  // 2026-09-08: the accessible name derives from the `label` prop
  // («Категорія: …» / «Бренд: …»).
  assert.match(
    c,
    /aria-label=\{`\$\{label\}: /,
    'trigger needs an accessible name built from the label prop'
  );
});

// ---- keyboard behaviour ----

test('CATEGORY-SELECT: Escape closes and returns focus to the trigger', () => {
  const c = combo();
  assert.match(c, /Escape/, 'Escape handler missing');
  // explicit ref-driven refocus of the trigger button
  assert.match(c, /triggerRef[\s\S]*?\.focus\(\)|\.focus\(\)[\s\S]*?triggerRef/,
    'close path must restore focus to the trigger');
});

test('CATEGORY-SELECT: ArrowDown/ArrowUp navigate, Enter selects', () => {
  const c = combo();
  assert.match(c, /ArrowDown/);
  assert.match(c, /ArrowUp/);
  assert.match(c, /Enter/);
  // navigation must be clamped to the rendered option range
  assert.match(c, /Math\.min\(|Math\.max\(/, 'active index must stay in bounds');
});

test('CATEGORY-SELECT: «Всі категорії» is part of the keyboard path (2026-09-04)', () => {
  const c = combo();
  // The all-row is activeIndex 0: activedescendant can point AT it, Enter
  // on it clears the selection, and it carries the stable option id.
  // 2026-09-08: the DOM id is namespaced (`${idPrefix}-opt-0`); the
  // category adapter pins idPrefix="category" so it stays `category-opt-0`.
  assert.match(c, /-opt-0/, 'all-row must own activedescendant slot 0');
  assert.match(c, /activeIndex === 0[\s\S]{0,200}?onChange\(''\)/,
    'Enter on the all-row must clear the selection');
  assert.match(c, /filtered\[activeIndex - 1\]/,
    'category rows sit at activeIndex n → filtered[n-1]');
  assert.match(c, /onMouseMove=\{\(\) => setRawActiveIndex\(0\)\}/,
    'hover parity with keyboard for the all-row');
  assert.match(select(), /idPrefix="category"/,
    'category combobox keeps its `category-opt-*` DOM namespace');
});

test('CATEGORY-SELECT: search input is a real focusable field', () => {
  const c = combo();
  assert.match(c, /<input\b/, 'search must be a native input');
  assert.match(c, /type="text"|type="search"/);
  // 2026-09-08: the accessible name is the searchPlaceholder prop
  // («Пошук категорій...» for categories, «Пошук брендів...» for brands).
  assert.match(c, /aria-label=\{searchPlaceholder\}/, 'search needs an accessible name');
  assert.match(select(), /searchPlaceholder="Пошук категорій\.\.\."/,
    'category search keeps its uk accessible name');
});

test('CATEGORY-SELECT: focus moves into the panel when it opens', () => {
  const c = combo();
  // search input receives focus on open (autofocus effect)
  assert.match(c, /searchInputRef[\s\S]*?\.focus\(\)/, 'open must focus the search field');
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
  // 2026-09-08: the slug mapping moved into the ComboboxOption adapter —
  // `value` carries the slug, never the label.
  assert.match(s, /value:\s*option\.slug/,
    'parent gets the slug, not the label');
  assert.match(s, /Всі категорії/, 'clear affordance kept');
});

test('CATEGORY-SELECT: duplicate names are disambiguated by branch label', () => {
  const s = select();
  assert.match(s, /option\.label/, 'list must render the full path label');
});

// ---- collapsible tree (2026-08-26) ----

test('CATEGORY-TREE: toggle arrow carries aria-expanded + aria-controls, separate from selection', () => {
  assert.match(select(), /expandedIds/, 'collapsible state missing');
  const c = combo();
  // 2026-09-08: the toggle button rendering moved into FilterCombobox.
  assert.match(c, /aria-expanded=\{[^}]*isOpen|aria-expanded=\{isExpanded\}/,
    'toggle button must announce expansion');
  assert.match(c, /aria-controls=\{isOpen \? `\$\{idPrefix\}-kids-/, 'toggle must reference nested list');
  assert.match(c, /розгорнути\/згорнути/, 'toggle needs an accessible name distinct from selection');
});

test('CATEGORY-TREE: ArrowRight/ArrowLeft expand/collapse the active node', () => {
  const c = combo();
  assert.match(c, /'ArrowRight'/);
  assert.match(c, /'ArrowLeft'/);
  // 2026-09-08: the requested next state is explicit, so Right=expand and
  // Left=collapse stay exact through the adapter's onToggleExpand.
  assert.match(c, /onToggleExpand\(e\.key === 'ArrowRight'\)/);
  assert.match(select(), /onToggleExpand/, 'adapter must wire the expand toggle');
});

test('CATEGORY-TREE: search reveals everything; empty query honors collapsed state', () => {
  const s = select();
  assert.match(s, /query\.trim\(\)\s*===\s*''/, 'visibility must branch on search emptiness');
  assert.match(s, /buildCategoryOptions\(categories,\s*\{\s*expanded/, 'expanded set must feed the builder');
});

test('CATEGORY-TREE: URL contract untouched — selection still emits slug only', () => {
  const s = select();
  assert.match(s, /value:\s*option\.slug/);
});

// ---- shared combobox delegation (2026-09-08) ----

test('CATEGORY-SELECT: delegates to the shared FilterCombobox (2026-09-08)', () => {
  const s = select();
  assert.match(s, /<FilterCombobox/, 'category picker must reuse the generic combobox');
  assert.match(s, /allLabel="Всі категорії"/, 'reset row label comes from the adapter');
  assert.match(s, /selectedOption=/,
    'trigger label must survive collapse (selected option passed explicitly)');
});

// ---- dropdown entry animation (2026-09-08) ----
// Audit candidate #5: the panel opened instantly while the chevron was
// already animated. Entry is now a short opacity+translateY settle driven
// by a globals.css keyframe class; EXIT stays instant (unmount).
// 2026-09-08: the class now lives on the shared FilterCombobox panel.

test('CATEGORY-SELECT: dropdown entry class + motion-reduce opt-out are pinned on the panel (2026-09-08)', () => {
  const c = combo();
  assert.match(
    c,
    /className="dropdown-in[^"]*motion-reduce:animate-none[^"]*"/,
    'dropdown panel must carry the globals.css entry class with a reduced-motion fallback'
  );
  // The class lives on the absolutely positioned panel (CLS=0 context),
  // not on some inner wrapper.
  assert.match(
    c,
    /<div className="dropdown-in[^"]*absolute z-20/,
    'entry animation belongs to the absolute-positioned listbox panel'
  );
});

test('CATEGORY-SELECT: dropdown-in keyframes are opacity/transform-only in globals.css (2026-09-08)', () => {
  const css = src('app/globals.css');
  const kf = css.match(/@keyframes dropdown-in \{[\s\S]*?\n  \}/);
  assert.ok(kf, 'dropdown-in keyframes must exist in globals.css');
  const body = kf[0];
  assert.match(body, /opacity:\s*0/, 'entry starts transparent');
  assert.match(body, /opacity:\s*1/, 'entry ends opaque');
  assert.match(body, /translateY\(-4px\)/, 'entry settles downward from the trigger');
  assert.match(body, /translateY\(0\)/);
  // Layout-affecting properties are forbidden inside the keyframes: the
  // panel is absolute (CLS=0) and the animation must not change that.
  assert.doesNotMatch(
    body,
    /\b(?:width|height|max-height|min-height|margin|padding|top|left|right|bottom|inset|position|display|font-size|border)\s*:/,
    'keyframes must stay opacity/transform-only (no layout properties)'
  );
  // The component class wires the keyframes with a short (~150-200ms) ease.
  assert.match(
    css,
    /\.dropdown-in \{\s*animation:\s*dropdown-in\s+\d+ms\s+ease-out;\s*\}/,
    '.dropdown-in must apply the keyframes with a short ease-out duration'
  );
});
