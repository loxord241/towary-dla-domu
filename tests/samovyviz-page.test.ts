/**
 * «Самовивіз» page (owner task 2026-09-14): indexable /samovyviz with
 * photos of both Кривий Ріг pickup points, wired into every site entrance.
 *
 * Source-level pins in the project style (node:test + readFileSync):
 *  1. Route + metadata — indexable (no noindex), self-canonical, unique
 *     title; exactly one <h1>; min-h-[44px] tap targets; phones and the
 *     «дзвінки до 16:00» line.
 *  2. Both points present with photos — every referenced /pickup/*.jpg
 *     exists in public/ and respects the ≤200 KB commit invariant.
 *  3. Entrances — footer INFO_LINKS, checkout PickupBlock «Як нас знайти →»
 *     (without touching the point buttons/pins), and the sitemap static
 *     entry (indexable set = sitemap set invariant).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const PAGE = src('app/samovyviz/page.tsx');
const FOOTER = src('app/components/SiteFooter.tsx');
const PICKUP_BLOCK = src('app/checkout/parts/PickupBlock.tsx');
const SITEMAP = src('app/sitemap.ts');

// ---------------------------------------------------------------------------
// 1. Route + metadata: indexable, self-canonical, single h1
// ---------------------------------------------------------------------------

test('SAMOVYVIZ: page exists, indexable, self-canonical, unique title', () => {
  // Indexable: the page must NOT opt out of indexing (lib/seo.ts policy —
  // «indexable set = sitemap set», and /samovyviz IS in the sitemap).
  assert.ok(!PAGE.includes('noindex'), 'page must stay indexable');
  assert.match(PAGE, /alternates:\s*\{\s*canonical:\s*'\/samovyviz'\s*\}/);
  assert.match(PAGE, /Самовивіз у Кривому Розі — Товари для дому/);
  // Unique description mentioning both directions + the city.
  assert.match(PAGE, /description:\s*'[^']*(обои|шпалери|Шпалери)[^']*'/);
});

test('SAMOVYVIZ: exactly one h1, mobile tap targets, phones, calls line', () => {
  assert.equal((PAGE.match(/<h1/g) ?? []).length, 1, 'exactly one h1 literal');
  assert.match(PAGE, /min-h-\[44px\]/, 'tel: link is a ≥44px tap target');
  assert.match(PAGE, /tel:\+380973144221/);
  assert.match(PAGE, /tel:\+380983584958/);
  assert.match(PAGE, /Приймаємо дзвінки та передзвонюємо до 16:00/);
});

// ---------------------------------------------------------------------------
// 2. Both points with photos (files committed, ≤200 KB each)
// ---------------------------------------------------------------------------

test('SAMOVYVIZ: both pickup points with canonical addresses', () => {
  // Same canonical forms as PICKUP_POINTS (checkout-delivery.ts whitelist;
  // wallpapers street renamed 2026-09-14: Серафимовича → Мазепи 83А).
  assert.match(PAGE, /вул\. Гетьмана Івана Мазепи, 87А/);
  assert.match(PAGE, /вул\. Гетьмана Івана Мазепи, 83А/);
  assert.match(PAGE, /Побутова техніка і товари для дому/);
  assert.match(PAGE, /Шпалери/);
  assert.match(PAGE, /Безкоштовно/);
});

test('SAMOVYVIZ: next/image photos with width/height, files committed ≤200 KB', () => {
  assert.match(PAGE, /import Image from 'next\/image'/);
  assert.match(PAGE, /width=\{960\}/);
  assert.match(PAGE, /height=\{1280\}/);
  // The first photo may compete for LCP — exactly one priority on the page.
  assert.equal((PAGE.match(/priority=/g) ?? []).length, 1);

  // Photo sets are generated (7 mazepy + 9 mazepy-83a — the wallpapers
  // point, formerly «serafimovycha» files, renamed 2026-09-14): pin the
  // generation contract, then verify every generated file exists on disk
  // within the ≤200 KB cap.
  assert.match(PAGE, /Array\.from\(\{ length: 7 \}[\s\S]*?\/pickup\/mazepy-\$\{i \+ 1\}\.jpg/);
  assert.match(PAGE, /Array\.from\(\{ length: 9 \}[\s\S]*?\/pickup\/mazepy-83a-\$\{i \+ 1\}\.jpg/);
  const referenced = [
    ...Array.from({ length: 7 }, (_, i) => `mazepy-${i + 1}.jpg`),
    ...Array.from({ length: 9 }, (_, i) => `mazepy-83a-${i + 1}.jpg`),
  ];
  for (const name of referenced) {
    const file = path.join(root, 'public', 'pickup', name);
    assert.ok(existsSync(file), `public/pickup/${name} must be committed`);
    const size = statSync(file).size;
    assert.ok(
      size <= 200 * 1024,
      `public/pickup/${name} is ${(size / 1024).toFixed(0)} KB — owner cap is 200 KB`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Entrances: footer, checkout PickupBlock, sitemap
// ---------------------------------------------------------------------------

test('SAMOVYVIZ: footer info link present', () => {
  assert.match(FOOTER, /\{ href: '\/samovyviz', label: 'Самовивіз' \}/);
});

test('SAMOVYVIZ: checkout PickupBlock links «Як нас знайти →»', () => {
  assert.match(PICKUP_BLOCK, /import Link from 'next\/link'/);
  assert.match(PICKUP_BLOCK, /href="\/samovyviz"/);
  assert.match(PICKUP_BLOCK, /Як нас знайти →/);
  // The link must not disturb the point buttons contract (checkout-pickup
  // pins): point buttons render p.address from PICKUP_POINTS, unchanged.
  assert.match(PICKUP_BLOCK, /\{p\.address\}/);
  assert.match(PICKUP_BLOCK, /aria-pressed=\{selected\}/);
});

test('SAMOVYVIZ: static sitemap entry (indexable set = sitemap set)', () => {
  assert.match(SITEMAP, /'\/samovyviz'/);
});
