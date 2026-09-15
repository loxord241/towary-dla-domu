/**
 * Піни фінального рішення по кнопці «Додати в кошик» на PDP — owner
 * 2026-09-15: ОДНА кнопка, одразу під ціною (попередні варіанти з дублем
 * над характеристиками та fixed-баром власник відхилив — «зроби як було,
 * просто кнопку одразу після ціни»).
 *
 * Source-pin патерн (див. tests/audit-2026-09-14-followups.test.ts):
 * node:test не рендерить .tsx, тож інтеграцію сторінки пінимо інспекцією
 * сирця app/product/[slug]/page.tsx.
 *
 * Контракт:
 *  - РІВНО ОДИН <AddToCartButton на сторінці (без дублів і fixed-барів);
 *  - стоїть ПІСЛЯ блоку ціни (formatPrice(product.price) іще вище) і ДО
 *    ShareButtons та <ProductIntro — тобто одразу під ціною;
 *  - футер без mobільного pb-24 (fixed-бара більше немає).
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

test('PDP-BUYBOX: рівно ОДИН інстанс AddToCartButton (без дублів і барів)', () => {
  assert.equal(
    countOf(pageSrc, '<AddToCartButton'),
    1,
    'кнопка має бути одна — дублі/фіксовані бари власник відхилив'
  );
  assert.ok(
    !/fixed inset-x-0 bottom-0|hidden md:block|md:hidden/.test(
      pageSrc.slice(
        pageSrc.indexOf('<AddToCartButton') - 200,
        pageSrc.indexOf('<AddToCartButton') + 400
      )
    ),
    'кнопка мусить жити в потоці сторінки без обгорток-дублів'
  );
});

test('PDP-BUYBOX: кнопка стоїть одразу під ціною, до ShareButtons і ProductIntro', () => {
  const priceAt = pageSrc.indexOf('formatPrice(product.price, product.currency)');
  const btnAt = pageSrc.indexOf('<AddToCartButton');
  const shareAt = pageSrc.indexOf('<ShareButtons');
  const introAt = pageSrc.indexOf('<ProductIntro');
  assert.ok(priceAt > -1, 'блок ціни не знайдено');
  assert.ok(btnAt > priceAt, 'кнопка має стояти ПІСЛЯ ціни');
  assert.ok(shareAt > -1 && btnAt < shareAt, 'кнопка має стояти ДО «Поділитися»');
  assert.ok(introAt > -1 && btnAt < introAt, 'кнопка має стояти ДО intro/характеристик');
});

test('PDP-BUYBOX: повний набір пропсів єдиного інстансу', () => {
  assert.equal(countOf(pageSrc, 'variants={product.variants.map'), 1);
  assert.equal(
    countOf(pageSrc, 'availabilityStatus={product.availability_status}'),
    1
  );
});

test('PDP-BUYBOX: «Передзвоніть мені» стоїть під кнопкою корзини (owner 2026-09-15)', () => {
  const btnAt = pageSrc.indexOf('<AddToCartButton');
  const cbAt = pageSrc.indexOf('<CallbackRequest');
  const shareAt = pageSrc.indexOf('<ShareButtons');
  assert.ok(cbAt > -1, 'CallbackRequest не знайдено');
  assert.ok(btnAt > -1 && cbAt > btnAt, 'CallbackRequest має стояти після кнопки корзини');
  assert.ok(shareAt > -1 && cbAt < shareAt, 'CallbackRequest має стояти до «Поділитися»');
});

test('PDP-BUYBOX: футер без mobільного pb-24 (fixed-бар прибраний)', () => {
  const footerSrc = readFileSync(path.join(root, 'app/components/SiteFooter.tsx'), 'utf8');
  assert.doesNotMatch(footerSrc, /pb-24/, 'зайвий відступ під бар, якого більше немає');
});
