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

// ---- meta description chain ----

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
  for (const boiler of [TRAMONTINA, LUMINARC_R, LUMINARC_PLAIN, PYREX]) {
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
