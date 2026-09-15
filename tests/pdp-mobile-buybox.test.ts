/**
 * TDD-піни (red→green) для мобільного бай-бокса на PDP — аудит #13,
 * рішення owner 2026-09-15: на телефоні кнопка «Купити» стоїть ПІСЛЯ
 * характеристик/бренд-блоків і губиться під складкою, тому її дублюють
 * ВИЩЕ — одразу під ціною, до ProductIntro. Реалізації ще немає (її робить
 * паралельний агент в іншому worktree), тому ці тести ЧЕРВОНІ зараз і
 * зеленіють після злиття гілки.
 *
 * Source-pin патерн (див. tests/audit-2026-09-14-followups.test.ts):
 * node:test не рендерить .tsx, тож інтеграцію сторінки пінимо інспекцією
 * сирця app/product/[slug]/page.tsx.
 *
 * Контракт:
 *  - РІВНО два <AddToCartButton (мобільний + десктопний);
 *  - мобільний: обгортка <div className="mb-6 md:hidden">, у сирці ДО <ProductIntro;
 *  - десктопний: обгортка <div className="hidden md:block">, ПІСЛЯ <ProductIntro;
 *  - повний паритет пропсів в обох екземплярів (variants.map /
 *    availability_status зустрічаються мінімум двічі).
 *
 * «ProductIntro рівно один раз» вже пінить tests/pdp-description-intro.test.ts —
 * тут свідомо НЕ дублюємо, тільки нові твердження.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSrc = readFileSync(path.join(root, 'app/product/[slug]/page.tsx'), 'utf8');

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ---- аудит #13 / owner 2026-09-15: мобільний бай-бокс -------------------------

test('PDP-BUYBOX: рівно два інстанси AddToCartButton (мобільний + десктопний)', () => {
  assert.equal(
    countOf(pageSrc, '<AddToCartButton'),
    2,
    'мобільний дубль кнопки ще не додано (реалізація owner 2026-09-15)'
  );
});

test('PDP-BUYBOX: мобільний екземпляр — у div.mb-6.md:hidden, ДО ProductIntro', () => {
  const mobileAt = pageSrc.indexOf('<div className="mb-6 md:hidden">');
  assert.ok(mobileAt > -1, 'мобільна обгортка <div className="mb-6 md:hidden"> відсутня');
  const introAt = pageSrc.indexOf('<ProductIntro');
  assert.ok(introAt > -1, 'ProductIntro не знайдено на сторінці');
  assert.ok(
    mobileAt < introAt,
    'мобільна кнопка має стояти ВИЩЕ характеристик — у сирці до <ProductIntro>'
  );
  // обгортка саме обгортає кнопку, а не якийсь сусідній блок (аудит #13)
  assert.match(
    pageSrc.slice(mobileAt, mobileAt + 240),
    /^<div className="mb-6 md:hidden">[\s\S]{0,200}?<AddToCartButton/,
    'усередині мобільної обгортки має монтуватися AddToCartButton'
  );
});

test('PDP-BUYBOX: десктопний екземпляр — у div.hidden.md:block, ПІСЛЯ ProductIntro', () => {
  const desktopAt = pageSrc.indexOf('<div className="hidden md:block">');
  assert.ok(desktopAt > -1, 'десктопна обгортка <div className="hidden md:block"> відсутня');
  const introAt = pageSrc.indexOf('<ProductIntro');
  assert.ok(introAt > -1, 'ProductIntro не знайдено на сторінці');
  assert.ok(
    desktopAt > introAt,
    'десктопна кнопка має лишитися на колишньому місці — після <ProductIntro>'
  );
  assert.match(
    pageSrc.slice(desktopAt, desktopAt + 240),
    /^<div className="hidden md:block">[\s\S]{0,200}?<AddToCartButton/,
    'усередині десктопної обгортки має монтуватися AddToCartButton'
  );
});

test('PDP-BUYBOX: паритет пропсів — обидва екземпляри отримують повний набір', () => {
  // owner 2026-09-15: обидві кнопки керуються одними даними товару, тож
  // variants.map та availability_status мусять зустрічатися мінімум двічі
  assert.ok(
    countOf(pageSrc, 'variants={product.variants.map') >= 2,
    'variants={product.variants.map(...) має бути в обох екземплярів (мін. 2 входження)'
  );
  assert.ok(
    countOf(pageSrc, 'availabilityStatus={product.availability_status}') >= 2,
    'availabilityStatus={product.availability_status} має бути в обох екземплярів (мін. 2 входження)'
  );
});
