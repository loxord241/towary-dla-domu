/**
 * Static invariants for the storefront navigation drawer (2026-08 client UX).
 *
 * The drawer is a client island in the server-rendered SiteHeader. JSX is
 * not executable in node:test (established pattern), so these tests pin the
 * SOURCE invariants: dialog semantics, all five close mechanisms, focus
 * handling, navigation targets built from existing routes, and the fact
 * that the pre-existing navigation (header «Каталог», footer info block)
 * survives the change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// ---- hamburger trigger (rendered by the NavDrawer island inside SiteHeader)

test('DRAWER: SiteHeader hosts the island; the island exposes an accessible toggle', () => {
  const header = src('app/components/SiteHeader.tsx');
  assert.match(header, /<NavDrawer\b/);
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /aria-label="Відкрити меню"/);
  assert.match(drawer, /aria-expanded/);
  assert.match(drawer, /<MenuIcon\b/);
});

// ---- dialog semantics

test('DRAWER: panel uses dialog semantics with an accessible name', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /role="dialog"/);
  assert.match(drawer, /aria-modal="true"/);
  assert.match(drawer, /aria-label="Навігаційне меню"/);
});

// ---- five close mechanisms

test('DRAWER: closes via Escape, overlay, close button, toggle and navigation', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /Escape/, 'Escape key handler missing');
  assert.match(drawer, /aria-label="Закрити меню"/, 'close button missing');
  // overlay click closes: the backdrop element has its own click handler
  assert.match(drawer, /onClick=\{onClose\}/, 'overlay click-to-close missing');
  // link click closes: every drawer link passes through a shared close handler
  assert.match(drawer, /onClick=\{closeAfterNavigate\}|onClick=\{\(\) => \{[^}]*onClose/, 'close-on-navigate missing');
  // hamburger toggles (aria-expanded flip asserted in the island)
  const drawerSrc = src('app/components/NavDrawer.tsx');
  assert.match(drawerSrc, /setOpen\(\(o\) => !o\)|setOpen\(!open\)/, 'toggle handler missing');
});

// ---- focus handling + scroll lock

test('DRAWER: manages focus and locks body scroll while open', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /\.focus\(\)/, 'no programmatic focus handling');
  assert.match(drawer, /overflow-hidden|overflow\s*=\s*['"]hidden['"]/, 'no body scroll lock');
  assert.match(drawer, /onKeyDown|keydown/i, 'no keydown handling for focus trap/escape');
});

// ---- navigation targets from existing architecture

test('DRAWER: shop section targets existing routes only', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /\/about/);
  assert.match(drawer, /\/delivery/);
  assert.match(drawer, /\/returns/);
  assert.match(drawer, /\/orders\/lookup/);
});

test('DRAWER: categories and brands link through catalog filters', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /\/catalog\?category=\$\{|\/catalog\?category='/);
  assert.match(drawer, /\/catalog\?brand=/);
  assert.match(drawer, /Усі категорії/, 'all-categories overflow link missing');
  assert.match(drawer, /Усі бренди/, 'all-brands overflow link missing');
  assert.match(drawer, /\/api\/catalog-dictionaries/, 'drawer must load existing dictionaries');
});

test('DRAWER: dictionary endpoint serves existing catalog data read-only', () => {
  const route = src('app/api/catalog-dictionaries/route.ts');
  assert.match(route, /export\s+async function GET|export const GET/);
  assert.match(route, /fetchActiveCategories/);
  assert.match(route, /fetchActiveBrands/);
  assert.ok(!route.includes('.insert(') && !route.includes('.update(') && !route.includes('.delete('),
    'dictionary route must be read-only');
});

// ---- pre-existing navigation survives

test('DRAWER: header catalog link and footer info block are not removed', () => {
  const header = src('app/components/SiteHeader.tsx');
  assert.match(header, /href="\/catalog"/, 'header «Каталог» link missing');
  const footer = src('app/components/SiteFooter.tsx');
  assert.match(footer, /Доставка і оплата/);
  assert.match(footer, /Статус замовлення/);
  assert.match(footer, /Політика конфіденційності/);
});

// ---- touch-friendly targets

test('DRAWER: nav links have touch-friendly sizing', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /min-h-\[44px\]|min-h-11|py-3/, 'links must have >=44px touch targets');
});
