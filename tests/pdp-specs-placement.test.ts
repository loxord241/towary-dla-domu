/**
 * PDP UX: «Характеристики» move into the description slot when the «Опис»
 * section has nothing to render (NULL/empty/HTML-shell description and no
 * short_description fallback). With a renderable description the existing
 * layout (Опис у картці → Характеристики нижче сітки) must stay unchanged.
 *
 * Coverage split (node:test cannot import .tsx — same convention as
 * product-specifications.test.ts):
 *  - branch decision: shouldRenderDescriptionSection (pure .ts, real calls);
 *  - placement/order: static source invariants on page.tsx + ProductSpecifications.tsx.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageSrc = readFileSync(
  path.join(root, 'app/product/[slug]/page.tsx'),
  'utf8'
);
const specsSrc = readFileSync(
  path.join(root, 'app/components/ProductSpecifications.tsx'),
  'utf8'
);
const { shouldRenderDescriptionSection } = await import(
  '../app/lib/product-description.ts'
);

// ---- shared page structure invariants ---------------------------------------

function assertPageBranching(): void {
  // ONE decision point drives both placements — no second, divergent check.
  assert.match(
    pageSrc,
    /const renderDescription = shouldRenderDescriptionSection\(\s*product\.description,\s*product\.short_description\s*\)/,
    'сторінка має рівно один gate — shouldRenderDescriptionSection'
  );
  // Description branch: heading + ProductDescription inside the ternary.
  assert.match(
    pageSrc,
    /renderDescription \? \([\s\S]*?>Опис<[\s\S]*?<ProductDescription/,
    'при наявності опису рендериться блок «Опис» із ProductDescription'
  );
  // Specs branch: inline variant occupies the description slot (same card).
  // UPDATE L11 (2026-09-18, display-вимога власника): вираз пропа змінено
  // product.specifications → displaySpecifications (сторінкове злиття
  // «Ширина» для ln-*, інші домени — сирі як було). Інваріант під піном —
  // РОЗТАШУВАННЯ (inline у слоті «Опис» без опису) — не змінено.
  assert.match(
    pageSrc,
    /: \(\s*<ProductSpecifications\s+specifications=\{displaySpecifications\}\s+variant="inline"\s*\/>\s*\)/,
    'без опису Характеристики займають слот «Опис» у картці товару'
  );
  // Below-grid section variant renders ONLY when the description is shown
  // (no duplicate blocks on description-less pages).
  // UPDATE L11 (2026-09-18): та сама зміна виразу пропа
  // (displaySpecifications) — інваріант розташування без змін.
  assert.match(
    pageSrc,
    /\{renderDescription && \(\s*<ProductSpecifications specifications=\{displaySpecifications\} \/>\s*\)\}/,
    'повноширинний блок Характеристик нижче сітки — лише коли є Опис'
  );
  assert.equal(
    (pageSrc.match(/variant="inline"/g) ?? []).length,
    1,
    'inline-варіант використовується рівно один раз'
  );
}

// ---- 1. description + specifications ----------------------------------------

test('case 1 (description + specs): current order kept — Опис у картці, Характеристики нижче сітки', () => {
  assert.equal(shouldRenderDescriptionSection('<p>Реальний опис</p>', null), true);
  assertPageBranching();
  assert.match(
    specsSrc,
    /Характеристики товару/,
    'section-варіант зберігає повний заголовок'
  );
});

// ---- 2. no description + specifications -------------------------------------

test('case 2 (no description + specs): Характеристики у слоті «Опис», без дубля нижче', () => {
  assert.equal(shouldRenderDescriptionSection(null, null), false);
  assertPageBranching();
  assert.match(
    specsSrc,
    /variant === 'inline'/,
    'компонент має inline-варіант для розміщення в картці'
  );
});

// ---- 3. empty/HTML-shell description + specifications ------------------------

test('case 3 (HTML-shell description + specs): shell ховається, Характеристики у слоті «Опис»', () => {
  assert.equal(
    shouldRenderDescriptionSection('<div>\r\n<div>\r\n<div></div>\r\n</div>\r\n</div>', null),
    false
  );
  assert.equal(shouldRenderDescriptionSection('<p>&nbsp;</p>', null), false);
  assertPageBranching();
});

// ---- 4. meaningful short description + specifications ------------------------

test('case 4 (short meaningful description + specs): опис рендериться як завжди, inline не вмикається', () => {
  assert.equal(
    shouldRenderDescriptionSection('<p>Рамка для фотографії 10х15 см.</p>', null),
    true
  );
  assertPageBranching();
  // The description branch (with ProductDescription) must come BEFORE the
  // inline-specs else-branch — short descriptions never land in the specs slot.
  const ternary = pageSrc.slice(
    pageSrc.indexOf('renderDescription ?'),
    pageSrc.indexOf('variant="inline"')
  );
  assert.ok(ternary.includes('<ProductDescription'));
});

// ---- 5. no description + no specifications ----------------------------------

test('case 5 (no description + no specs): жодного порожнього блоку чи самотнього заголовка', () => {
  // Component still returns null for empty rows — BEFORE any JSX — so BOTH
  // variants disappear entirely (no orphan heading in the description slot).
  assert.match(specsSrc, /if \(rows\.length === 0\) return null;/);
  const bodyAfterNull = specsSrc.slice(specsSrc.indexOf('return null;') + 'return null;'.length);
  assert.ok(
    !bodyAfterNull.includes('if (rows.length === 0)'),
    'немає другої гілки порожнечі — повернення null мусить бути спільним для обох варіантів'
  );
  // The inline heading lives INSIDE the component, not hardcoded on the page,
  // so an empty spec set cannot leave a stray «Характеристики» heading.
  const inlineBlock = specsSrc.slice(specsSrc.indexOf("variant === 'inline'"));
  assert.match(inlineBlock, /Характеристики/);
  assert.ok(
    !pageSrc.slice(pageSrc.indexOf('variant="inline"') - 200, pageSrc.indexOf('variant="inline"'))
      .includes('>Характеристики<'),
    'заголовок inline-блоку не має бути захардкодженим на сторінці'
  );
});
