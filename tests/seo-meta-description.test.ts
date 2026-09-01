/**
 * PDP meta-description policy (audit 2026-08-31):
 *   - supplier "empty HTML" descriptions (tags/nbsp only) must count as
 *     ABSENT → the generic name-based fallback is used;
 *   - supplier brand boilerplate templates must NOT leak into meta
 *     descriptions (hundreds of duplicated metas on live data);
 *   - unique descriptions and short_description are unchanged;
 *   - no content is ever invented: the generic fallback is name-based.
 * DB, importer, sitemap, canonical and Product JSON-LD are out of scope
 * and must stay untouched by this policy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildProductMetaDescription,
  isBoilerplateDescription,
  isPlaceholderDescription,
} from '../app/lib/seo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

// Real samples from the 2026-08-31 production audit.
const GARBAGE_DIV = '<div>\r\n<div>\r\n<div></div>\r\n</div>\r\n</div>';
const TRAMONTINA =
  '<p>Кожен виріб <strong>Tramontina </strong>розробляється з умовою, щоб він зміг задовольнити найвибірливіші смаки.</p>';
const LUMINARC_R =
  '<p><strong>Luminarc ®</strong> - бренд високоякісного посуду, що випускається французькою компанією Arcopal.</p>';
const LUMINARC_PLAIN =
  '<p><strong>Luminarc </strong>® - бренд високоякісного посуду, що випускається французькою компанією Arcopal.</p>';
const PYREX =
  '<p>Винайдений у Франції 1915 року, <strong>Pyrex </strong>революціонізував кухонне скло.</p>';
const UNIQUE_DESC = '<p>Кавоварка рожева з колбою з боросилікатного скла, обсяг 0.6 л.</p>';

// ---- placeholder detection ----

test('META: tags/nbsp-only HTML counts as a placeholder description', () => {
  assert.equal(isPlaceholderDescription(GARBAGE_DIV), true);
  assert.equal(isPlaceholderDescription('<p>&nbsp;</p>'), true);
  assert.equal(isPlaceholderDescription('   '), true);
  assert.equal(isPlaceholderDescription(null), true);
  assert.equal(isPlaceholderDescription(undefined), true);
});

test('META: real descriptions are NOT placeholders', () => {
  assert.equal(isPlaceholderDescription(UNIQUE_DESC), false);
  assert.equal(isPlaceholderDescription('Простий текст'), false);
  assert.equal(isPlaceholderDescription(TRAMONTINA), false);
});

// ---- boilerplate detection ----

test('META: brand boilerplate templates are detected (case/whitespace robust)', () => {
  assert.equal(isBoilerplateDescription(TRAMONTINA), true);
  assert.equal(isBoilerplateDescription(LUMINARC_R), true);
  assert.equal(isBoilerplateDescription(LUMINARC_PLAIN), true);
  assert.equal(isBoilerplateDescription(PYREX), true);
});

test('META: unique descriptions are NOT boilerplate', () => {
  assert.equal(isBoilerplateDescription(UNIQUE_DESC), false);
  assert.equal(isBoilerplateDescription(null), false);
  assert.equal(isBoilerplateDescription(''), false);
});

// ---- Task #24: verified V2 marker set (Task #23 audit, 2026-09-01) ----
// One sample per NEW marker; each sample embeds the marker verbatim, so
// recognition can only pass once the marker ships in BOILERPLATE_MARKERS.
const V2_BOILERPLATE_SAMPLES: readonly string[] = [
  '<p>Цей посуд виготовляється ексклюзивно для Юг-контракт.</p>',
  '<p>Посуд виготовляється ексклюзивно для компанії вже понад десять років.</p>',
  '<p>Посуд для приготування під торговою маркою IQ поєднує якість і стиль.</p>',
  '<p>Торгова марка Ringel відома своїми кухонними аксесуарами.</p>',
  '<p>Ringel - бренд якісного посуду для дому.</p>',
  '<p>Кухонні аксесуари Ringel зроблять кухню затишнішою.</p>',
  '<p>Bravo Chef – це посуд для тих, хто любить готувати.</p>',
  '<p>Компанія Kastamonu багаторічний досвід виробництва меблевих плит.</p>',
  '<p>IPEC - найбільший виробник побутової техніки в Туреччині.</p>',
  '<p>Бренд Tramontina заснований у Бразилії понад сто років тому.</p>',
  '<p>Фоторамка LA — елегантне рішення для вашого інтер’єру.</p>',
  '<p>Серія Guten Morgen створена для приємних ранкових сніданків.</p>',
  '<p>Серія Longchamp втілює класичний французький стиль.</p>',
  '<p>Kora від Limited Edition — це витончений декор для дому.</p>',
  '<p>Шторка для ванної Idea Home захищає від бризів.</p>',
  '<p>Бренд Arcoroc належить французькій групі Arc International.</p>',
  '<p>Бренд Chef&Sommelier створений для професійної сервіровки.</p>',
  '<p>Франція і кухня мають особливий зв’язок у культурі цієї країни.</p>',
  '<p>У металевих серіях ТМ Pyrex поєднані міцність та дизайн.</p>',
  '<p>Сковорідки та каструлі Pyrex з антипригарним покриттям.</p>',
  '<p>Серія ножів Athus виготовлена з нержавіючої сталі.</p>',
  '<p>Команда фахівців ТМ Eleyus розробляє витяжки вже 15 років.</p>',
  '<p>Наша компактна пральна машина ідеально підходить для малих квартир.</p>',
  '<p>Скатертина водовідштовхувальна прямокутна 140x200 см.</p>',
  '<p>Вішалка для одягу з гачками Idea Home економить простір.</p>',
  '<p>Особливості сковорід Oscar Chef — товсте дно та рівномірний нагрів.</p>',
  '<p>Каструля з литого алюмінію серії Zitrone підходить для індукції.</p>',
  '<p>Чому «Tesy»? Бо якість бойлерів перевірена часом.</p>',
  '<p>Ножі серії Master - ідеальні ножі для нарізки овочів та м’яса.</p>',
  '<p>Металеві вази для зберігання фруктів доповнюють інтер’єр.</p>',
  '<p>Стильна прикраса на вашому столі подарує гарний настрій.</p>',
  '<p>Чашки з подвійними стінками тримають напій гарячим довше.</p>',
  '<p>Склянки з подвійними стінками виготовлені з боросилікатного скла.</p>',
  '<p>Посуд і предмети для сервірування від бренду LED створені для дому.</p>',
  '<p>Колекція преміум-класу Rowenta поєднує технології та естетику.</p>',
  '<p>Чавунні решітки ProGrids міцні, стійкі та надійні.</p>',
  '<p>У руках майстрів своєї справи будь-який матеріал приймає потрібну форму.</p>',
];

test('META: every V2 boilerplate marker is recognized', () => {
  for (const sample of V2_BOILERPLATE_SAMPLES) {
    assert.equal(isBoilerplateDescription(sample), true, sample);
  }
});

test('META: V2 detection does not flag normal descriptions (no false positives)', () => {
  const normals: readonly string[] = [
    UNIQUE_DESC,
    '<p>Посуд Ringel для сервірування столу, 12 предметів.</p>',
    '<p>Келихи C&S для червоного вина, набір 6 шт.</p>',
    '<p>Набір ножів Tramontina з підставкою, 6 предметів.</p>',
    '<p>Сковорідка Pyrex 24 см зі знімною ручкою.</p>',
    '<p>Чайник Tesy з об’ємом 1,7 л, білий корпус.</p>',
    '<p>Чашки з подвійним дном, скло, 250 мл, прозорі.</p>',
    '<p>Рамка для фотографії 21x30 см, пластик, чорна.</p>',
    '<p>Електрочайник з контролером Strix, 2200 Вт.</p>',
    '<p>Пральна машина з завантаженням 6 кг, клас A+.</p>',
    '<p>Скатертина ПВХ з флокацією 140x200 см.</p>',
  ];
  for (const sample of normals) {
    assert.equal(isBoilerplateDescription(sample), false, sample);
  }
});

// ---- meta description chain (decision layer, unchanged semantics) ----

test('META: short_description wins over description', () => {
  const m = buildProductMetaDescription({
    productName: 'Кавоварка PHILIPS HD9318',
    shortDescription: 'Короткий опис товару',
    description: UNIQUE_DESC,
  });
  assert.equal(m, 'Короткий опис товару');
});

test('META: unique description is used as-is (capped at 160 chars)', () => {
  const m = buildProductMetaDescription({
    productName: 'Товар',
    description: UNIQUE_DESC,
  });
  assert.equal(m, 'Кавоварка рожева з колбою з боросилікатного скла, обсяг 0.6 л.');

  const long = '<p>' + 'А'.repeat(300) + '</p>';
  const capped = buildProductMetaDescription({ productName: 'Товар', description: long });
  assert.equal(capped?.length, 160);
});

test('META: placeholder description falls back to the generic name-based meta', () => {
  const m = buildProductMetaDescription({
    productName: 'Кавоварка PHILIPS HD9318',
    description: GARBAGE_DIV,
  });
  assert.equal(m, 'Купити Кавоварка PHILIPS HD9318 в інтернет-магазині Товари для дому.');
});

test('META: boilerplate description falls back to the generic meta (no duplicated metas)', () => {
  const cs: string = V2_BOILERPLATE_SAMPLES[16]; // Chef&Sommelier sample
  for (const boiler of [TRAMONTINA, LUMINARC_R, LUMINARC_PLAIN, PYREX, cs]) {
    assert.equal(
      buildProductMetaDescription({ productName: 'Набір посуду', description: boiler }),
      'Купити Набір посуду в інтернет-магазині Товари для дому.'
    );
  }
});

test('META: nothing at all still yields the generic meta', () => {
  assert.equal(
    buildProductMetaDescription({ productName: 'Тостер UP! ET1706' }),
    'Купити Тостер UP! ET1706 в інтернет-магазині Товари для дому.'
  );
});

// ---- wiring + scope invariants ----

test('META: product page uses the policy builder for metadata', () => {
  const page = src('app/product/[slug]/page.tsx');
  assert.match(page, /buildProductMetaDescription/);
  assert.ok(!page.includes('metaDescription(product.description)'), 'old inline chain must be gone');
});

test('META: policy scope only — sitemap/JSON-LD/schema-org untouched', () => {
  const schema = src('app/lib/schema-org.ts');
  assert.ok(!schema.includes('buildProductMetaDescription'), 'JSON-LD builder must not change');
  const sitemap = src('app/sitemap.ts');
  assert.ok(!sitemap.includes('buildProductMetaDescription'), 'sitemap must not change');
  const seo = src('app/lib/seo.ts');
  assert.ok(!seo.includes('is_main'), 'policy must stay metadata-only');
});
