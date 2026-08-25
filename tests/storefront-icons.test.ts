/**
 * Static invariants for the storefront emoji → inline-SVG icon migration.
 *
 * Storefront UI must not depend on OS emoji fonts (tofu risk on stripped
 * down Linux/Windows builds). Following the established ux-fixes /
 * pagination-hardening pattern (JSX is not executable in node:test), these
 * tests pin SOURCE invariants so a revert fails loudly:
 *   - replaced emoji glyphs are gone from touched storefront files;
 *   - accessible labels of existing controls survive the swap;
 *   - real <svg> markup / icon components are used instead;
 *   - interactive hit areas are not reduced;
 *   - HeartIcon supports both filled and outline states;
 *   - EmptyState accepts ReactNode icons (default BoxIcon).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

/** Codepoints of the emoji UI icons this migration removed from the storefront. */
const REPLACED_EMOJI =
  /[\u{1F50D}\u{1F6D2}\u{2764}\u{FE0F}\u{1F90D}\u{1F4E6}\u{1F5D1}]/gu;

const TOUCHED_FILES = [
  'app/components/SiteHeader.tsx',
  'app/components/CartBadge.tsx',
  'app/components/FavoritesBadge.tsx',
  'app/components/FavoriteButton.tsx',
  'app/components/EmptyState.tsx',
  'app/catalog/page.tsx',
  'app/cart/page.tsx',
  'app/favorites/page.tsx',
  'app/error.tsx',
];

// ---- 1. replaced emoji glyphs are gone

test('ICONS: no replaced emoji glyphs remain in touched storefront files', () => {
  for (const rel of TOUCHED_FILES) {
    const found = src(rel).match(REPLACED_EMOJI) ?? [];
    assert.deepEqual(
      found,
      [],
      `${rel}: emoji UI icons must be replaced by inline SVG (found ${JSON.stringify(found)})`
    );
  }
});

// ---- 2. the icon module itself

test('ICONS: icons.tsx defines all six components as inline stroke SVGs', () => {
  const icons = src('app/components/icons.tsx');
  for (const name of [
    'SearchIcon',
    'CartIcon',
    'HeartIcon',
    'BoxIcon',
    'TrashIcon',
    'WarningIcon',
  ]) {
    assert.match(icons, new RegExp(`export function ${name}\\b`), `${name} missing`);
  }
  // stroke-based inline SVG contract (attr or shared-props-object form)
  assert.match(icons, /viewBox=\{"?0 0 24 24"?\}|viewBox: '0 0 24 24'/);
  assert.match(icons, /fill=\{"?none"?\}|fill: 'none'/);
  assert.match(icons, /stroke=\{"?currentColor"?\}|stroke: 'currentColor'/);
  assert.match(icons, /'aria-hidden':\s*true|aria-hidden="true"/);
  // no external/remote assets
  assert.ok(!icons.includes('http'), 'icons must be inline, not remote');
});

test('ICONS: HeartIcon renders filled and outline states via a filled flag', () => {
  const icons = src('app/components/icons.tsx');
  assert.match(icons, /filled\?:?\s*boolean/);
  assert.match(
    icons,
    /filled\s*\?\s*'currentColor'\s*:\s*'none'/,
    'heart fill must switch between currentColor (filled) and none (outline)'
  );
});

// ---- 3. controls keep their accessible names and really use the SVGs

test('ICONS: SiteHeader search keeps aria-labels and renders SearchIcon', () => {
  const header = src('app/components/SiteHeader.tsx');
  assert.match(header, /aria-label="Пошук"/);
  assert.match(header, /aria-label="Шукати"/);
  assert.match(header, /<SearchIcon\b/);
});

test('ICONS: CartBadge keeps its aria-label and renders CartIcon', () => {
  const badge = src('app/components/CartBadge.tsx');
  assert.match(badge, /Кошик, товарів/);
  assert.match(badge, /<CartIcon\b/);
});

test('ICONS: FavoritesBadge keeps its aria-label and renders a filled HeartIcon', () => {
  const badge = src('app/components/FavoritesBadge.tsx');
  assert.match(badge, /Обране, товарів/);
  assert.match(badge, /<HeartIcon\b[^>]*filled/);
});

test('ICONS: FavoriteButton keeps labels, aria-pressed and swaps hearts by state', () => {
  const fav = src('app/components/FavoriteButton.tsx');
  assert.match(fav, /Додати до обраного/);
  assert.match(fav, /Прибрати з обраного/);
  assert.match(fav, /aria-pressed=\{active\}/);
  assert.match(fav, /<HeartIcon\b[^>]*filled=\{active\}/);
});

// ---- 4. hit areas are not reduced

test('ICONS: hit-area invariants survive the icon swap', () => {
  assert.match(src('app/components/FavoriteButton.tsx'), /h-6 w-6/);
  const header = src('app/components/SiteHeader.tsx');
  assert.match(header, /h-8 w-8/);
  assert.match(header, /pr-12/);
  assert.match(src('app/components/CartBadge.tsx'), /p-2/);
  assert.match(src('app/components/FavoritesBadge.tsx'), /p-2/);
});

test('ICONS: error boundary renders WarningIcon instead of an emoji', () => {
  const boundary = src('app/error.tsx');
  assert.match(boundary, /<WarningIcon\b/);
  // size stays in the text-4xl (~40px) range and keeps the decorative
  // aria-hidden wrapper — behaviour and a11y unchanged
  assert.match(boundary, /<WarningIcon className="h-10 w-10[^"]*"/);
  assert.match(boundary, /aria-hidden className="mb-3"/);
});

// ---- 5. EmptyState takes ReactNode icons; pages pass sized SVGs

test('ICONS: EmptyState accepts ReactNode icons with an SVG default', () => {
  const empty = src('app/components/EmptyState.tsx');
  assert.match(empty, /icon\?: ReactNode/);
  assert.match(empty, /<BoxIcon\b/);
});

test('ICONS: empty-state pages pass sized SVG icons', () => {
  assert.match(src('app/catalog/page.tsx'), /<SearchIcon className="h-10 w-10"/);
  assert.match(src('app/cart/page.tsx'), /<CartIcon className="h-10 w-10"/);
  const favorites = src('app/favorites/page.tsx');
  assert.match(favorites, /<HeartIcon className="h-10 w-10"/);
  assert.match(favorites, /<TrashIcon\b/);
});
