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

// ---- linoleum hub entrance (owner task L9, 2026-09-17)

test('DRAWER: /linoleum hub is linked from the desktop nav and the drawer shop list', () => {
  const header = src('app/components/SiteHeader.tsx');
  // Desktop nav: «Лінолеум» link mirrors «Шпалери» (same class, same row).
  assert.match(header, /href="\/linoleum"[^>]*>\s*Лінолеум/, 'header nav linoleum link missing');
  const drawer = src('app/components/NavDrawer.tsx');
  // Drawer SHOP_LINKS: symmetric with «Шпалери» (/oboi) already listed there.
  assert.match(drawer, /href:\s*'\/linoleum'/, 'drawer linoleum link missing');
});

test('DRAWER: categories and brands link through catalog filters', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  // Pinned categories are hardcoded links on the human-readable path form
  // (owner task 2026-09-13): /catalog/<slug>; brands keep the query form.
  assert.match(drawer, /\/catalog\/\$\{m\.slug\}/);
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
  // The footer «Магазин» column was intentionally removed (it duplicated
  // the drawer's SHOP_LINKS); the footer keeps order status + contacts/legal.
  const footer = src('app/components/SiteFooter.tsx');
  assert.match(footer, /Статус замовлення/);
  assert.match(footer, /Політика конфіденційності/);
  // Shop info links stay reachable through the drawer with the current label.
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /Доставка та оплата/);
});

// ---- touch-friendly targets

test('DRAWER: nav links have touch-friendly sizing', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /min-h-\[44px\]|min-h-11|py-3/, 'links must have >=44px touch targets');
});

// ---- open/close animation (2026-08 UX)

test('DRAWER: panel slides via CSS transform transition with a sane duration', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /transition-transform/, 'panel must animate transform');
  assert.match(drawer, /-translate-x-full/, 'closed state parks the panel off-screen (left)');
  assert.match(drawer, /translate-x-0/, 'open state slides the panel in');
  // 200–300ms window
  assert.match(drawer, /duration-\[(2|3)\d{2}ms\]/, 'duration must be 200–300ms range');
});

test('DRAWER: overlay fades simultaneously via CSS opacity transition', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.match(drawer, /transition-opacity/, 'overlay must fade via opacity');
  assert.match(drawer, /'opacity-100'/, 'visible overlay target missing');
  assert.match(drawer, /opacity-0/, 'hidden overlay target missing');
});

test('DRAWER: closing plays the reverse animation (deferred unmount)', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  assert.ok(
    !drawer.includes('{open && <DrawerPanel'),
    'instant conditional render would skip the exit animation'
  );
  assert.match(drawer, /setMounted\(false\)/, 'unmount must be state-driven');
  assert.match(drawer, /setTimeout\(/, 'unmount must be deferred so the exit can play');
  assert.match(drawer, /setShown\(false\)/, 'close must flip the animated target first');
});

test('DRAWER: animation respects prefers-reduced-motion', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  const fallbacks = (drawer.match(/motion-reduce:/g) ?? []).length;
  assert.ok(fallbacks >= 2, `panel AND overlay need motion-reduce fallbacks, found ${fallbacks}`);
});

test('DRAWER: animation does not remove any of the five close mechanisms', () => {
  const drawer = src('app/components/NavDrawer.tsx');
  // Escape + overlay + X button are re-asserted here because the refactor
  // touched the render output they live in.
  assert.match(drawer, /Escape/);
  assert.match(drawer, /onClick=\{onClose\}/);
  assert.match(drawer, /aria-label="Закрити меню"/);
  assert.match(drawer, /setOpen\(\(o\) => !o\)/);
  assert.match(drawer, /onClick=\{closeAfterNavigate\}/);
});
