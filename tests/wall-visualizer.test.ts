/**
 * Статические инварианты страницы-примерочной /vizualizator (бриф
 * владельца 2026-09-11, референс AERIAL): комната + панель образцов,
 * тап — обои «сами клеятся». Ручек, слайдера и калькулятора внутри НЕТ.
 * node:test не рендерит .tsx — source-inspection по обычаю проекта.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const app = read('app/components/WallVisualizerApp.tsx');
const page = read('app/vizualizator/page.tsx');
const pdp = read('app/product/[slug]/page.tsx');
const catalog = read('app/lib/catalog.ts');

test('viz: страница серверная — метаданные, canonical, deep-link params', () => {
  assert.match(page, /export const metadata: Metadata/);
  assert.match(page, /Візуалізатор шпалер/);
  assert.match(page, /canonical: '\/vizualizator'/);
  assert.match(page, /searchParams/);
  assert.match(page, /wallpaper \?\?|params\.wallpaper/);
  assert.match(page, /fetchWallpaperSwatches\(\)/);
});

test('viz: срез образцов — только wc-* с фото, главное фото, ширина рулона', () => {
  assert.match(catalog, /fetchWallpaperSwatches/);
  assert.match(catalog, /\.like\('sku', WALLPAPER_SKU_LIKE\)/, 'только домен обоев');
  assert.match(catalog, /product_images!inner/, 'элигибельность по фото');
  assert.match(catalog, /\.eq\('is_active', true\)/);
  assert.match(catalog, /parseRollSize\(row\.name\)/);
});

test('viz: островок — тап клеит сам, БЕЗ ручек/слайдера/калькулятора', () => {
  assert.ok(app.startsWith("'use client'"));
  assert.match(app, /from '@\/app\/lib\/wallpapers\/visualizer-math'/);
  assert.match(app, /homography\(/);
  assert.match(app, /setSelectedSlug\(swatch\.slug\)/, 'тап по образцу клеит');
  // калькулятор и ручки удалены из примерочной
  assert.ok(!/type="range"/.test(app), 'слайдера высоты нет');
  assert.ok(!/Скинути/.test(app), 'кнопки «Скинути» нет');
  assert.ok(!/roll-calculator|stripsForWall/.test(app), 'калькулятор/смуги не в примерочной');
  assert.ok(!/setPointerCapture/.test(app), 'drag-ручки удалены');
  // при этом поиск и deep-link есть
  assert.match(app, /type="search"/);
  assert.match(app, /history\.replaceState/);
  // мобильный контракт
  assert.match(app, /min-h-\[44px\]/);
  assert.match(app, /wrap-anywhere/);
  assert.match(app, /loading="lazy"/);
});

test('viz: модалка старая удалена, PDP ведёт на страницу с товаром', () => {
  assert.equal(existsSync(path.join(root, 'app/components/WallVisualizer.tsx')), false);
  assert.equal(existsSync(path.join(root, 'app/components/WallVisualizerSlot.tsx')), false);
  assert.ok(!pdp.includes('WallVisualizerSlot'), 'слот удалён с PDP');
  assert.match(pdp, /vizualizator\?wallpaper=\$\{product\.slug\}/);
  // при этом калькулятор на PDP остался
  assert.match(pdp, /id="roll-calculator"/);
});
