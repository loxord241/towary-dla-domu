/**
 * SEO links package (2026-09-13): internal links, breadcrumb JSON-LD and
 * the PDP share/title work.
 *
 * Pins four sides of one decision so they cannot drift apart:
 *  1. internal category links point at the PATH form /catalog/<slug> —
 *     the legacy /catalog?category=<slug> shape only 308-redirects now
 *     (proxy.ts → catalogCategoryRedirect, pinned in
 *     catalog-category-paths.test.ts);
 *  2. BreadcrumbList JSON-LD emits the same path form through the shared
 *     catalogCategoryPath() helper;
 *  3. ShareButtons is a client island mounted on the PDP (Viber / Telegram
 *     / copy-link, 44px touch targets, aria-labels);
 *  4. wallpaper PDP TITLE cleanup (comma-chain junk tails, ~70-char cap) —
 *     full name stays in H1 and og:title.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildProductBreadcrumbJsonLd,
  buildCatalogBreadcrumbJsonLd,
  catalogCategoryPath,
} from '../app/lib/schema-org.ts';
import {
  cleanWallpaperTitle,
  isWallpaperNaming,
  TITLE_CAP,
} from '../app/lib/wallpapers/title.ts';

const root = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string =>
  readFileSync(join(root, '..', rel), 'utf8');

// ---- 1. internal links: path form everywhere -------------------------------

test('LINKS: home category cards link to /catalog/<slug> (path form)', () => {
  const home = src('app/(home)/page.tsx');
  assert.match(
    home,
    /href=\{`\/catalog\/\$\{encodeURIComponent\(category\.slug\)\}`\}/
  );
  assert.doesNotMatch(home, /\/catalog\?category=/);
});

test('LINKS: /oboi subcategory + glue chips link to /catalog/<slug>', () => {
  const page = src('app/oboi/page.tsx');
  assert.match(
    page,
    /href=\{`\/catalog\/\$\{encodeURIComponent\(subcategory\.slug\)\}`\}/
  );
  assert.match(
    page,
    /href=\{`\/catalog\/\$\{encodeURIComponent\(GLUE_CATEGORY_SLUG\)\}`\}/
  );
  assert.doesNotMatch(page, /\/catalog\?category=/);
});

test('LINKS: PDP trail and «Категорія» block link to /catalog/<slug>', () => {
  const pdp = src('app/product/[slug]/page.tsx');
  const pathLinks = pdp.match(
    /\/catalog\/\$\{encodeURIComponent\(product\.category\.slug\)\}/g
  );
  assert.ok(pathLinks !== null && pathLinks.length === 2,
    'both the breadcrumb trail and the «Категорія» block use the path form');
  // Brand links intentionally stay query-form (no path shape exists).
  assert.match(pdp, /\/catalog\?brand=/);
});

// ---- 2. breadcrumb JSON-LD: same path form ----------------------------------

test('JSONLD: catalogCategoryPath encodes the slug into /catalog/<slug>', () => {
  assert.equal(catalogCategoryPath('plyty-kombinovani-1421'),
    '/catalog/plyty-kombinovani-1421');
  // Encoding identical to the visible nav links (single encodeURIComponent).
  assert.equal(catalogCategoryPath('kat z probilom'), '/catalog/kat%20z%20probilom');
  assert.equal(catalogCategoryPath('категорія-1'),
    `/catalog/${encodeURIComponent('категорія-1')}`);
});

test('JSONLD: product breadcrumb category item is the absolute path-form URL', () => {
  const SITE = 'https://towary-dla-domu.com';
  const ld = buildProductBreadcrumbJsonLd(
    { name: 'Товар', slug: 'tovar-1' },
    { name: 'Шпалери', slug: 'shpaleri-9' },
    SITE
  ) as { itemListElement: { item: string }[] };
  assert.equal(ld.itemListElement[2]!.item,
    `${SITE}/catalog/shpaleri-9`);
  assert.doesNotMatch(JSON.stringify(ld), /catalog\?category=/);
});

test('JSONLD: catalog breadcrumb category item is the absolute path-form URL', () => {
  const SITE = 'https://towary-dla-domu.com';
  const ld = buildCatalogBreadcrumbJsonLd(
    { name: 'Шпалери', slug: 'shpaleri 9' },
    SITE
  ) as { itemListElement: { item: string }[] };
  assert.equal(ld.itemListElement[2]!.item,
    `${SITE}/catalog/shpaleri%209`);
  assert.doesNotMatch(JSON.stringify(ld), /catalog\?category=/);
});

// ---- 3. ShareButtons on the PDP ---------------------------------------------

test('SHARE: ShareButtons is a client island mounted on the PDP', () => {
  const component = src('app/components/ShareButtons.tsx');
  const pdp = src('app/product/[slug]/page.tsx');

  // Client island with serializable props only (url/title from the page).
  assert.match(component, /'use client';/);
  assert.match(component, /export default function ShareButtons/);
  assert.match(component, /url: string/);
  assert.match(component, /title: string/);

  // Mounted directly in the server page, near the price; URL built from the
  // same NEXT_PUBLIC_SITE_URL basis as the JSON-LD builders.
  assert.match(pdp, /import ShareButtons from '@\/app\/components\/ShareButtons'/);
  assert.match(pdp, /<ShareButtons\s+url=\{\`\$\{siteUrl/);
  assert.match(pdp, /\/product\/\$\{product\.slug\}`\}/);
  assert.match(pdp, /title=\{product\.name\}/);
});

test('SHARE: three channels — viber://forward, t.me/share/url, clipboard copy', () => {
  const component = src('app/components/ShareButtons.tsx');
  // Viber: one combined "title — url" message.
  assert.match(component, /viber:\/\/forward\?text=\$\{encodeURIComponent/);
  assert.match(component, /\$\{title\} — \$\{url\}/);
  // Telegram: url and text passed separately.
  assert.match(component, /https:\/\/t\.me\/share\/url\?url=\$\{encodeURIComponent/);
  // Copy: clipboard API + visible «Скопійовано» state with a reset timer.
  assert.match(component, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(component, /'Скопійовано'/);
  assert.match(component, /'Копіювати посилання'/);
  // Touch + a11y contract: 44px targets, aria-label on every control.
  assert.match(component, /min-h-\[44px\]/);
  assert.match(component, /aria-label="Поділитися у Viber"/);
  assert.match(component, /aria-label="Поділитися в Telegram"/);
  assert.match(component, /aria-label="Копіювати посилання"/);
});

// ---- 4. wallpaper PDP TITLE cleanup ------------------------------------------

test('TITLE: comma-chain junk tail is dropped when the remainder stays meaningful', () => {
  // The audit example: «41704 рожева полоса,шпалери,53см*10м» → tail gone.
  assert.equal(
    cleanWallpaperTitle('41704 рожева полоса,шпалери,53см*10м'),
    '41704 рожева полоса,шпалери'
  );
  // Single tail: size chunk after the category word.
  assert.equal(cleanWallpaperTitle('шпалери,53см*10м'), 'шпалери');
});

test('TITLE: nothing is dropped when the remainder would be meaningless', () => {
  // Remainder shorter than MIN_MEANINGFUL → keep the original name.
  assert.equal(cleanWallpaperTitle('ab,шпалери'), 'ab,шпалери');
  // No comma at all → untouched.
  assert.equal(cleanWallpaperTitle('шпалери 53см'), 'шпалери 53см');
  // Empty → empty.
  assert.equal(cleanWallpaperTitle(''), '');
});

test('TITLE: result never exceeds the ~70-char cap', () => {
  // 100 chars → drops to «…перевищує ліміт» (60) at comma boundaries.
  const long =
    '0123456789 дуже довга назва шпалер яка точно перевищує ліміт,ще один сегмент,третій сегмент,53см*10м';
  const cleaned = cleanWallpaperTitle(long);
  assert.ok(cleaned.length <= TITLE_CAP, `got ${cleaned.length} chars`);
  assert.equal(cleaned,
    '0123456789 дуже довга назва шпалер яка точно перевищує ліміт');
  // No comma boundary left → hard cap with an ellipsis.
  const noComma = 'ш'.repeat(80);
  const capped = cleanWallpaperTitle(noComma);
  assert.equal(capped.length, TITLE_CAP);
  assert.ok(capped.endsWith('…'));
});

test('TITLE: the wc-* gate matches the PDP wallpaper domain', () => {
  assert.equal(isWallpaperNaming('wc-41704', 'shpaleri-41704'), true);
  assert.equal(isWallpaperNaming('24010/106', 'wc-something'), true);
  assert.equal(isWallpaperNaming('24010/106', 'plyta-beko-7081966'), false);
});

test('TITLE: PDP uses the cleaned name for <title> only; og:title stays full', () => {
  const pdp = src('app/product/[slug]/page.tsx');
  assert.match(pdp, /cleanWallpaperTitle/);
  assert.match(pdp, /isWallpaperNaming\(product\.sku, product\.slug\)/);
  // TITLE gets titleName; og:title keeps the full product.name.
  assert.match(pdp, /title: `\$\{titleName\} — Товари для дому`/);
  assert.match(pdp, /title: `\$\{product\.name\} — Товари для дому`/);
  // The visible H1 is untouched (full name, wrap-anywhere).
  assert.match(pdp, /<h1 className="min-w-0 wrap-anywhere text-2xl font-bold mb-2">\{product\.name\}<\/h1>/);
});
