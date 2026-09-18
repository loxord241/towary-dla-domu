/**
 * Static invariants for the Epicentr-style PDP intro (spec 2026-09-14,
 * Phase 1). node:test cannot render React (.tsx), so the page integration
 * is pinned by source inspection — the same convention as
 * pdp-specs-placement.test.ts / roll-calculator.test.ts. The generation
 * logic itself is unit-tested for real in tests/description-generator.test.ts.
 *
 * Pins:
 *  - description-generator.ts is PURE (no react/next imports — node:test-loadable);
 *  - page.tsx mounts ProductIntro exactly once, under the price, BEFORE the
 *    existing «Опис» ternary, passing the product's real category slug and
 *    the existing shouldRenderDescriptionSection result;
 *  - ProductIntro gates lead+key specs at ≥3 sanitized specs, reuses the
 *    ProductSpecifications inline markup for «Основні характеристики», and
 *    renders the generated «Опис» ONLY for products without a real one;
 *  - ProductSpecifications' new heading prop keeps the historical defaults.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatorSrc = readFileSync(
  path.join(root, 'app/lib/description-generator.ts'),
  'utf8'
);
const introSrc = readFileSync(
  path.join(root, 'app/components/ProductIntro.tsx'),
  'utf8'
);
const specsComponentSrc = readFileSync(
  path.join(root, 'app/components/ProductSpecifications.tsx'),
  'utf8'
);
const pageSrc = readFileSync(
  path.join(root, 'app/product/[slug]/page.tsx'),
  'utf8'
);

// ---- pure core ----------------------------------------------------------------

test('description-generator: чисте ядро — без react/next/компонентних імпортів (node:test-loadable)', () => {
  for (const banned of [/from 'react/, /from "react/, /from 'next/, /from "next/, /from '@\//, /require\(/]) {
    assert.ok(!banned.test(generatorSrc), `заборонений імпорт: ${banned}`);
  }
  assert.ok(!generatorSrc.includes("'use client'"));
});

// ---- PDP page integration -----------------------------------------------------

test('PDP: ProductIntro імпортується та монтується рівно один раз', () => {
  assert.match(
    pageSrc,
    /import ProductIntro from '@\/app\/components\/ProductIntro'/,
    'сторінка імпортує ProductIntro'
  );
  assert.equal(
    (pageSrc.match(/<ProductIntro/g) ?? []).length,
    1,
    'вступний блок монтується рівно в одному місці сторінки'
  );
});

test('PDP: монтаж під H1/ціною і ДО існуючого слота «Опис» (порядок Epicentr §2.1)', () => {
  const introAt = pageSrc.indexOf('<ProductIntro');
  const ternaryAt = pageSrc.indexOf('renderDescription ?');
  assert.ok(introAt > 0 && ternaryAt > introAt, 'ProductIntro стоїть до гілки «Опис»');
  // ...і після блоку ціни (лід — під H1/ціною)
  const priceAt = pageSrc.indexOf('formatPrice(product.price');
  assert.ok(priceAt > 0 && introAt > priceAt, 'ProductIntro стоїть після блоку ціни');
});

test('PDP: у ProductIntro передаються реальні дані товару + існуюний gate опису', () => {
  // UPDATE L11 (2026-09-18, display-вимога власника): вираз пропа
  // specifications змінено product.specifications → displaySpecifications —
  // сторінкове display-only злиття «Ширина» для ln-* (mergeSpecEntries під
  // гейтом isLinoleum), іншим доменам — сирі specifications як були.
  // Інваріант під піном («реальні дані товару») не змінено.
  assert.match(
    pageSrc,
    /<ProductIntro\s+name=\{product\.name\}\s+brandName=\{product\.brand\?\.name \?\? null\}\s+specifications=\{displaySpecifications\}\s+categorySlug=\{product\.category\?\.slug \?\? null\}\s+hasRealDescription=\{renderDescription\}\s*\/>/,
    'props: name, brand, specifications, category slug з normalizeProduct і результат shouldRenderDescriptionSection'
  );
  //_existing placements preserved: інші гємні тести (pdp-specs-placement) фіксують
  // тернарник «Опис»/inline-характеристики й нижчирегістрову таблицю — тут
  // додатково пінимо, що ProductIntro НЕ замінив жоден з них.
  assert.match(pageSrc, /renderDescription \? \([\s\S]*?>Опис<[\s\S]*?<ProductDescription/);
  // Та сама зміна виразу пропа, що й вище (UPDATE L11 2026-09-18).
  assert.match(pageSrc, /\{renderDescription && \(\s*<ProductSpecifications specifications=\{displaySpecifications\} \/>\s*\)\}/);
});

// ---- ProductIntro component ---------------------------------------------------

test('ProductIntro: серверний компонент на чистому ядрі description-generator', () => {
  assert.ok(!introSrc.startsWith("'use client'"), 'без "use client" — серверний рендер');
  assert.match(
    introSrc,
    /import \{[^}]*buildLeadParagraph[^}]*\} from '@\/app\/lib\/description-generator'/
  );
  for (const fn of ['buildKeySpecs', 'buildGeneratedDescription', 'LEAD_MIN_SPECS']) {
    assert.ok(introSrc.includes(fn), `використовує ${fn} з description-generator`);
  }
  assert.ok(
    !introSrc.includes('dangerouslySetInnerHTML'),
    'без HTML-sink — єдиний sink проекту лишається в ProductDescription'
  );
});

test('ProductIntro: лід і «Основні характеристики» — тільки при ≥3 характеристик (гейт спеки §7)', () => {
  assert.match(
    introSrc,
    /sanitizeSpecRows\(specifications\)/,
    'гейт рахує САНИТИЗОВАНІ рядки, а не сирий JSONB'
  );
  assert.match(introSrc, /rows\.length >= LEAD_MIN_SPECS/);
});

test('ProductIntro: «Основні характеристики» — ProductSpecifications inline з фірмовим заголовком', () => {
  assert.match(
    introSrc,
    /<ProductSpecifications\s+specifications=\{keySpecs\}\s+variant="inline"\s+heading="Основні характеристики"\s*\/>/,
    'top-ключі рендеряться реюзом inline-розмітки ProductSpecifications'
  );
  assert.equal(
    (introSrc.match(/<ProductSpecifications/g) ?? []).length,
    1,
    'рівно один монтаж таблиці ключових характеристик'
  );
});

test('ProductIntro: згенерований «Опис» — лише БЕЗ реального опису, замість заглушки', () => {
  assert.match(
    introSrc,
    /hasRealDescription\s*\?\s*null\s*:\s*buildGeneratedDescription/,
    'реальний supplier-опис має пріоритет над генерацією'
  );
  assert.match(introSrc, />Опис</, 'генерація рендериться під заголовком «Опис»');
  assert.match(introSrc, /generated\.format === 'list'/, 'техніка — список фич');
  assert.match(introSrc, /generated\.lines\.join\(' '\)/, 'посуда/інше — абзац');
  // Заглушка «Опис відсутній» не має рендеритися жодним шляхом нового блока
  assert.ok(!introSrc.includes('>Опис відсутній<'));
});

// ---- ProductSpecifications heading prop (backward compatibility) --------------

test('ProductSpecifications: heading-проп з історичними дефолтами (без зміни існуючих блоків)', () => {
  assert.match(
    specsComponentSrc,
    /heading\?\: string/,
    'новий опціональний heading'
  );
  assert.match(
    specsComponentSrc,
    /heading \?\? \(variant === 'inline' \? 'Характеристики' : 'Характеристики товару'\)/,
    'дефолти збережено дослівно'
  );
  // існуючі піни мають сенс далі: повний заголовок + empty-null інваріант
  assert.match(specsComponentSrc, /Характеристики товару/);
  assert.match(specsComponentSrc, /if \(rows\.length === 0\) return null;/);
});
