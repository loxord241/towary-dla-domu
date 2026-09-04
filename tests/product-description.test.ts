/**
 * Product page description rendering tests.
 *
 * Testing constraint (honest): the project intentionally has NO React
 * renderer / DOM test infrastructure, and installing one for a single
 * component is not justified. So the behaviour is covered two ways:
 *   1) the fallback decision is extracted into a PURE function
 *      (resolveProductDescription) and unit-tested directly;
 *   2) project-level invariants are enforced by reading the sources:
 *      exactly ONE dangerouslySetInnerHTML exists project-wide, it lives
 *      in ProductDescription.tsx, the sanitizer stays on the import
 *      layer only, and product page wires the component in.
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const { resolveProductDescription, shouldRenderDescriptionSection } =
  await import('../app/lib/product-description.ts');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function walkApp(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...walkApp(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// ---- pure fallback chain ------------------------------------------------------

test('resolveProductDescription: non-empty description wins as html', () => {
  const r = resolveProductDescription('<p>Опис</p>', 'короткий');
  assert.deepEqual(r, { kind: 'html', value: '<p>Опис</p>' });
});

test('resolveProductDescription: whitespace-only description falls back to short_description', () => {
  const r = resolveProductDescription('   ', 'Короткий опис');
  assert.deepEqual(r, { kind: 'text', value: 'Короткий опис' });
});

test('resolveProductDescription: null/undefined everywhere → placeholder', () => {
  assert.deepEqual(resolveProductDescription(null, undefined), {
    kind: 'text',
    value: 'Опис відсутній',
  });
  assert.deepEqual(resolveProductDescription('', ''), {
    kind: 'text',
    value: 'Опис відсутній',
  });
});

test('resolveProductDescription: short_description itself is trimmed', () => {
  const r = resolveProductDescription(null, '  пробіл  ');
  assert.deepEqual(r, { kind: 'text', value: 'пробіл' });
});

test('resolveProductDescription: plain manual text still takes the html path (renders identically)', () => {
  const r = resolveProductDescription('4534534dhfgh', null);
  assert.deepEqual(r, { kind: 'html', value: '4534534dhfgh' });
});

// ---- «Опис» section visibility gate (Task #41, 2026-09-02) --------------------

test('shouldRenderDescriptionSection: null/empty description → section absent', () => {
  assert.equal(shouldRenderDescriptionSection(null, null), false);
  assert.equal(shouldRenderDescriptionSection(undefined, undefined), false);
  assert.equal(shouldRenderDescriptionSection('', ''), false);
});

test('shouldRenderDescriptionSection: HTML-shell description → section absent', () => {
  assert.equal(shouldRenderDescriptionSection('<div><div></div></div>', null), false);
  assert.equal(
    shouldRenderDescriptionSection('<div><div><div></div></div></div>', null),
    false
  );
});

test('shouldRenderDescriptionSection: whitespace-only description → section absent', () => {
  assert.equal(shouldRenderDescriptionSection('   \n\t  ', null), false);
});

test('shouldRenderDescriptionSection: nbsp-only description → section absent', () => {
  assert.equal(shouldRenderDescriptionSection('&nbsp;', null), false);
  assert.equal(shouldRenderDescriptionSection('<p>&nbsp;</p>', null), false);
  assert.equal(shouldRenderDescriptionSection('&#160;', null), false);
  assert.equal(shouldRenderDescriptionSection('<p>&#160;</p>', null), false);
});

test('shouldRenderDescriptionSection: real description → section present', () => {
  assert.equal(shouldRenderDescriptionSection('<p>Нормальне описання</p>', null), true);
  assert.equal(
    shouldRenderDescriptionSection('<p>Блендер <strong>потужний</strong></p>', null),
    true
  );
});

test('shouldRenderDescriptionSection: short real description is NOT hidden for being short', () => {
  assert.equal(shouldRenderDescriptionSection('<p>Ок</p>', null), true);
});

test('shouldRenderDescriptionSection: real short_description keeps the section (fallback chain)', () => {
  assert.equal(
    shouldRenderDescriptionSection('<div><div></div></div>', 'Короткий опис'),
    true
  );
});

test('INVARIANT: product page gates the «Опис» section behind shouldRenderDescriptionSection', () => {
  const page = readFileSync(
    path.join(root, 'app/product/[slug]/page.tsx'),
    'utf8'
  );
  assert.ok(page.includes('shouldRenderDescriptionSection'));
  // the heading must live inside the gated block (same conditional render):
  // inspect everything AFTER the JSX call site (last occurrence, not the import)
  const gated = page.slice(page.lastIndexOf('shouldRenderDescriptionSection'));
  assert.ok(gated.includes('>Опис<'), 'заголовок «Опис» має рендеритися під gate');
});

// ---- project-wide source invariants -------------------------------------------

test('INVARIANT: exactly two sanctioned dangerouslySetInnerHTML sinks in app/', () => {
  // Allowlist (SEO package 2026-08-26): 1) ProductDescription — sanitized
  // supplier HTML; 2) ProductJsonLd — JSON-LD built by schema-org.ts and
  // serialized with '<'-escaping (see tests/seo-jsonld.test.ts).
  const ALLOWED = [/ProductDescription\.tsx$/, /ProductJsonLd\.tsx$/];
  const files = walkApp(path.join(root, 'app'));
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML'));
  assert.equal(hits.length, ALLOWED.length, `очікується рівно ${ALLOWED.length} файл(и), знайдено: ${hits.map((h) => path.relative(root, h)).join(', ')}`);
  for (const pattern of ALLOWED) {
    assert.ok(
      hits.some((h) => pattern.test(h)),
      `не вистачає санкціонованого sink'у: ${pattern}`
    );
  }
  // each sanctioned file holds exactly ONE actual usage (attribute);
  // comments may mention the term without counting
  for (const hit of hits) {
    const usages = readFileSync(hit, 'utf8').match(/dangerouslySetInnerHTML\s*=\s*\{\{/g);
    assert.equal(usages?.length ?? 0, 1, `лише один виклик у ${path.relative(root, hit)}`);
  }
});

test('INVARIANT: sanitize-html is imported only by content-sanitize.ts (import/staging layer)', () => {
  const files = walkApp(path.join(root, 'app'));
  const hits = files.filter((f) => readFileSync(f, 'utf8').includes("from 'sanitize-html'"));
  assert.equal(hits.length, 1);
  assert.ok(hits[0] !== undefined);
  assert.match(hits[0], /content-sanitize\.ts$/);
});

test('INVARIANT: ProductDescription does not import or run any sanitizer itself', () => {
  const src = readFileSync(path.join(root, 'app/components/ProductDescription.tsx'), 'utf8');
  // the component must not pull in a sanitizer library or call one:
  const importLines = src
    .split('\n')
    .filter((line) => line.trimStart().startsWith('import'));
  assert.ok(importLines.length >= 2);
  assert.ok(
    importLines.every((line) => !/sanitize/i.test(line)),
    `санитайзер не повинен імпортуватися: ${importLines.join(' | ')}`
  );
  assert.ok(!/sanitizeHtml|DOMPurify|purify/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ' ')));
  for (const banned of ['<iframe', '<script', 'javascript:', 'onerror']) {
    assert.ok(!src.includes(banned), `заборонений фрагмент у компоненті: ${banned}`);
  }
});

test('INVARIANT: product page renders through ProductDescription', () => {
  const page = readFileSync(
    path.join(root, 'app/product/[slug]/page.tsx'),
    'utf8'
  );
  assert.ok(page.includes('import ProductDescription'));
  assert.ok(page.includes('<ProductDescription'));
  // old plain-text render must be gone
  assert.ok(!page.includes("{product.description || product.short_description"));
});

test('INVARIANT: collapsible long description UI is present', () => {
  const src = readFileSync(
    path.join(root, 'app/components/ProductDescription.tsx'),
    'utf8'
  );
  assert.match(src, /'use client'/);
  assert.match(src, /Показати більше/);
  assert.match(src, /Згорнути/);
  assert.match(src, /aria-expanded=\{expanded\}/);
  // collapsed preview must clamp height without breaking the HTML block,
  // and squeeze wide tables instead of clipping them horizontally
  assert.match(src, /max-h-24 overflow-hidden \[&_table\]:max-w-full \[&_table\]:w-full/);
});
