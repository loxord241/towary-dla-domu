/**
 * Product-domain single source of truth (audit follow-up 8a, owner GO
 * 2026-09-13 «Делай 7»): the `wc-` prefix used to live in FOUR places
 * (catalog constants, a search-suggest literal, a private importer const,
 * an inline startsWith in the checkout). Now app/lib/domains.ts owns it;
 * everything else imports or re-exports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const domains = await import(
  pathToFileURL(path.join(root, 'app/lib/domains.ts')).href
) as typeof import('../app/lib/domains.ts');

test('DOMAINS: unit — prefix, like-pattern, slug classification', () => {
  assert.equal(domains.WALLPAPER_SKU_PREFIX, 'wc-');
  assert.equal(domains.WALLPAPER_SKU_LIKE, 'wc-%');
  assert.equal(domains.isWallpaperSlug('wc-37589'), true);
  assert.equal(domains.isWallpaperSlug('UC-68682222'), false);
  assert.equal(domains.isWallpaperSlug(''), false);
  assert.equal(domains.isWallpaperSlug(null), false);
  assert.equal(domains.isWallpaperSlug(undefined), false);
  assert.equal(domains.domainOfSlug('wc-1'), 'wallpaper');
  assert.equal(domains.domainOfSlug('anything'), 'tech');
  // Pure module: client-safe (checkout imports it), import-free entirely.
  const lib = src('app/lib/domains.ts');
  assert.doesNotMatch(lib, /^import /m, 'pure module must stay import-free');
});

test('DOMAINS: every former duplicate now rides the single module', () => {
  // catalog re-exports for its SQL consumers…
  const shared = src('app/lib/catalog/shared.ts');
  assert.match(shared, /export \{[\s\S]*?WALLPAPER_SKU_LIKE[\s\S]*?\} from '\.\.\/domains.ts'/);
  // …search-suggest re-exports for its sync-test…
  const suggest = src('app/lib/search-suggest.ts');
  assert.match(suggest, /export \{ WALLPAPER_SKU_LIKE \} from '\.\/domains\.ts'/);
  // …the importer imports the prefix…
  const importer = src('app/lib/wallpapers/import-plan.ts');
  assert.match(importer, /import \{ WALLPAPER_SKU_PREFIX \} from '\.\.\/domains.ts';/);
  assert.doesNotMatch(importer, /const WALLPAPER_SKU_PREFIX/);
  // …and the checkout uses the classifier, not an inline literal
  // (2026-09-17: domainOfSlug — covers wc-, ln- and the tech fallback
  // for the three-domain pickup filter).
  const form = src('app/checkout/CheckoutForm.tsx');
  assert.match(form, /import \{ domainOfSlug \} from '@\/app\/lib\/domains';/);
  assert.doesNotMatch(form, /startsWith\('wc-'\)/);
  // Pickup points share the vocabulary (no ad-hoc union).
  const delivery = src('app/lib/checkout-delivery.ts');
  assert.match(delivery, /domains: ReadonlyArray<ProductDomain>/);
});

test('DOMAINS: no runtime `wc-` literal left outside the owner module', () => {
  // Runtime code must derive the prefix from domains.ts; tests and comments
  // may still mention it. (Static list of the audited files.)
  const runtime = [
    'app/lib/catalog/shared.ts',
    'app/lib/search-suggest.ts',
    'app/lib/wallpapers/import-plan.ts',
    'app/checkout/CheckoutForm.tsx',
    'app/lib/checkout-delivery.ts',
  ];
  for (const rel of runtime) {
    const code = src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /'wc-'/, `${rel} must not hardcode the prefix`);
  }
});
