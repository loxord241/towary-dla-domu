// tests/wall-visualizer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');
const comp = read('app/components/WallVisualizer.tsx');
const slot = read('app/components/WallVisualizerSlot.tsx');
const pdp = read('app/product/[slug]/page.tsx');

test('wallviz: слот — client, ленивый import(), кнопка-открывашка', () => {
  assert.ok(slot.startsWith("'use client'"));
  assert.match(slot, /import\('\.\/WallVisualizer'\)/, 'ручной lazy import');
  assert.match(slot, /Подивитись в інтер'єрі/);
});

test('wallviz: модалка — a11y и мобильный контракт', () => {
  assert.match(comp, /role="dialog"/);
  assert.match(comp, /aria-modal/);
  assert.match(comp, /Escape/, 'закрытие по Esc');
  assert.match(comp, /document\.body\.style\.overflow = 'hidden'/, 'скролл-лок паттерна проекта');
  assert.match(comp, /overscroll-contain/);
  assert.match(comp, /motion-reduce:transition-none/);
  assert.match(comp, /touch-action:\s*none|touch-none/, 'ручки не скроллят страницу');
  const hit = comp.match(/h-11 w-11/g) ?? [];
  assert.ok(hit.length >= 5, 'ручки и крестик ≥44px');
});

test('wallviz: ручки — pointer capture + клавиатура, ничего не вгадывается', () => {
  assert.match(comp, /setPointerCapture/);
  assert.match(comp, /ArrowLeft/);
  assert.match(comp, /wallviz:\$\{/, 'localStorage-ключ per slug+room');
  assert.match(comp, /розмір рулона не вказано|орієнтовний/, 'подсказка при rollSize=null');
  assert.match(comp, /type="range"/);
  assert.match(comp, /min="2"/);
  assert.match(comp, /max="3\.5"/);
});

test('wallviz: математика из pure-модуля, тайлинг без канваса', () => {
  assert.match(comp, /from '@\/app\/lib\/wallpapers\/visualizer-math'/);
  assert.match(comp, /backgroundRepeat/, 'обои = background-repeat');
  assert.ok(!/canvas|getContext/.test(comp), 'канвас запрещён (CORS)');
  assert.match(comp, /stripsForWall/);
  assert.match(comp, /Скинути/);
  assert.match(comp, /До калькулятора/);
});

test('wallviz: PDP — гейт wc-* с фото, id калькулятора на месте', () => {
  assert.match(pdp, /WallVisualizerSlot/);
  assert.match(pdp, /id="roll-calculator"/);
  assert.match(
    pdp,
    /isWallpaper &&[\s\S]*galleryUrls\.length > 0[\s\S]*WallVisualizerSlot/,
    'блок только для шпалер с фото',
  );
});
