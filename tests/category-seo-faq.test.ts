/**
 * Category SEO texts + category FAQ stage (2026-09-11, owner-approved
 * «SEO-тексти на категорії» + «FAQ-блоки»).
 *
 * JSX is not executable in node:test (established project pattern), so
 * component invariants are pinned at source level; pure logic
 * (buildFaqJsonLd, splitDescriptionParagraphs, WALLPAPER_FAQ) is tested
 * by direct import. The SQL file is a draft seed applied by the
 * orchestrator via MCP — the test pins its coverage contract so the file
 * cannot silently drift from the 11 wallpaper slugs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WALLPAPER_FAQ, isWallpaperCategorySlug } from '../app/lib/faq-content.ts';
import { buildFaqJsonLd, serializeJsonLd } from '../app/lib/schema-org.ts';
import { splitDescriptionParagraphs } from '../app/lib/category-description.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

const EXPECTED_SLUGS = [
  'shpaleri',
  'shpaleri-akryl',
  'shpaleri-vinyl-10m',
  'shpaleri-vinyl-15m',
  'shpaleri-duplex',
  'shpaleri-metrovi',
  'shpaleri-flizelin',
  'shpaleri-shovkografiya',
  'shpaleri-miika-prosta',
  'shpaleri-prosti',
  'shpaleri-supermiika',
];

// ---- 1. data/category-seo-texts.sql covers exactly the 11 slugs -----------

test('SEO-TEXTS: sql file exists with a draft header (date, author, owner-editable note)', () => {
  const sql = src('data/category-seo-texts.sql');
  assert.match(sql, /2026-09-11/, 'draft date must be in the header');
  assert.match(sql, /автор/i, 'draft author must be in the header');
  assert.match(sql, /владел/i, 'owner-editable note must be in the header');
});

test('SEO-TEXTS: exactly 11 UPDATEs covering exactly the 11 wallpaper slugs', () => {
  const sql = src('data/category-seo-texts.sql');
  const updates = sql.match(/UPDATE categories SET description = '/g) ?? [];
  assert.equal(updates.length, 11, `expected 11 UPDATE statements, found ${updates.length}`);

  const statement = /SET description = '((?:[^']|'')+)' WHERE slug = '([a-z0-9-]+)';/g;
  const found: string[] = [];
  const literals: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = statement.exec(sql)) !== null) {
    const literal = match[1];
    const slug = match[2];
    if (!literal || !slug) continue;
    literals.push(literal);
    found.push(slug);
  }
  assert.equal(found.length, 11, 'every UPDATE must address exactly one slug');
  assert.deepEqual([...found].sort(), [...EXPECTED_SLUGS].sort());
  assert.equal(new Set(found).size, 11, 'no duplicate slugs');
  // regex round-trip proves single quotes are escaped ('') — a lone ' would
  // have terminated the literal and broken the match above
  for (const literal of literals) {
    assert.ok(literal.length >= 200, 'text too thin for a category description');
    const paragraphs = literal.split(/\r?\n\s*\r?\n/);
    assert.equal(paragraphs.length, 2, 'each text must be exactly two paragraphs');
    for (const paragraph of paragraphs) {
      assert.ok(paragraph.trim().length >= 80, 'each paragraph must carry real content');
    }
  }
});

test('SEO-TEXTS: texts are factual — no marketing boilerplate or invented claims', () => {
  const sql = src('data/category-seo-texts.sql').toLowerCase();
  for (const banned of [
    'років на ринку',
    'найкращ',
    'найдешев',
    '№1',
    'номер один',
    'топ-якість',
    'гарантія якості',
  ]) {
    assert.ok(!sql.includes(banned), `marketing claim leaked into seo texts: ${banned}`);
  }
});

// ---- 2. FaqSection / FaqJsonLd components ---------------------------------

test('FAQ: FaqSection is a server component with native details/summary (motion-safe)', () => {
  const component = src('app/components/FaqSection.tsx');
  assert.ok(!component.includes("'use client'"), 'must be a server component');
  assert.match(component, /WALLPAPER_FAQ/, 'content must come from the shared list');
  assert.match(component, /<details/, 'native details disclosure');
  assert.match(component, /<summary/, 'native summary disclosure');
  assert.match(component, /Часті питання/, 'visible section heading');
  // motion-reduce compliance: NO animation at all — instant native toggle,
  // nothing for reduced-motion users to opt out of
  assert.doesNotMatch(component, /transition-|animate-/, 'block must be animation-free');
  // plain text children only — no HTML parsing of FAQ strings
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/);
});

test('FAQ: FaqJsonLd holds exactly one sanitized script sink', () => {
  const component = src('app/components/FaqJsonLd.tsx');
  assert.match(component, /buildFaqJsonLd/, 'must build through the pure builder');
  assert.match(component, /serializeJsonLd/, "must use the '<'-escaping serializer");
  const usages = component.match(/dangerouslySetInnerHTML\s*=\s*\{\{/g);
  assert.equal(usages?.length ?? 0, 1, 'exactly one sink usage in the component');
  assert.ok(!component.includes("'use client'"), 'must be a server component');
});

// ---- 3. FAQPage JSON-LD builder + content facts ----------------------------

test('FAQ: buildFaqJsonLd emits an FAQPage with the full Q&A set', () => {
  const data = buildFaqJsonLd(WALLPAPER_FAQ);
  assert.ok(data, 'the 6-item FAQ list must produce a graph');
  const serialized = JSON.stringify(data);
  assert.ok(serialized.includes('"@type":"FAQPage"'), 'FAQPage type required');
  const mainEntity = data.mainEntity as unknown[];
  assert.equal(mainEntity.length, WALLPAPER_FAQ.length);
  assert.equal(
    (mainEntity[0] as Record<string, unknown>)['@type'],
    'Question',
    'mainEntity entries must be Question nodes'
  );
});

test('FAQ: builder drops empty pairs and escapes "<" (script-breakout guard)', () => {
  assert.equal(buildFaqJsonLd([]), null);
  assert.equal(buildFaqJsonLd([{ question: '  ', answer: 'x' }]), null);
  assert.equal(buildFaqJsonLd([{ question: 'Q', answer: '' }]), null);
  const hostile = buildFaqJsonLd([
    { question: 'Питання <b>з розміткою</b>', answer: 'Відповідь </script>' },
  ]);
  const serialized = serializeJsonLd(hostile as Record<string, unknown>);
  assert.ok(serialized.includes('\\u003c'), "'<' must be unicode-escaped");
  assert.ok(!serialized.includes('</'), 'no raw tag closer may reach the sink');
});

test('FAQ: content is 6 unique Q&A with short factual answers (verified facts only)', () => {
  assert.equal(WALLPAPER_FAQ.length, 6);
  assert.equal(new Set(WALLPAPER_FAQ.map((item) => item.question)).size, 6);
  for (const item of WALLPAPER_FAQ) {
    const sentences = item.answer.match(/[.!?]+(?=\s|$)/g)?.length ?? 0;
    assert.ok(
      sentences >= 1 && sentences <= 3,
      `answer must be 1–3 sentences: ${item.question}`
    );
    assert.ok(item.question.trim().length > 0 && item.answer.trim().length > 0);
  }
  const all = WALLPAPER_FAQ.map((item) => item.answer).join(' ');
  // facts verifiable against PROJECT_CONTEXT:
  assert.ok(all.includes('Нова Пошта') && all.includes('Укрпошта'), 'delivery carriers');
  assert.ok(all.includes('LiqPay'), 'payment fact');
  assert.ok(all.includes('калькулятор'), 'roll calculator on the product card');
  // policies we do NOT have codified must NOT be invented:
  const returns = WALLPAPER_FAQ.find((item) => item.question.includes('повернути'));
  assert.ok(returns && returns.answer.includes('домовленістю'), 'returns = manager agreement');
  const pickup = WALLPAPER_FAQ.find((item) => item.question.includes('самовивіз'));
  assert.ok(pickup && pickup.answer.includes('уточнюйте'), 'pickup = ask the manager');
  const shade = WALLPAPER_FAQ.find((item) => item.question.includes('відтінку'));
  assert.ok(shade && shade.answer.includes('відтінок'), 'shade disclaimer present');
});

test('FAQ: isWallpaperCategorySlug matches the shpaleri% subtree only', () => {
  assert.equal(isWallpaperCategorySlug('shpaleri'), true);
  for (const slug of EXPECTED_SLUGS.slice(1)) {
    assert.equal(isWallpaperCategorySlug(slug), true, slug);
  }
  assert.equal(isWallpaperCategorySlug(undefined), false);
  assert.equal(isWallpaperCategorySlug(''), false);
  assert.equal(isWallpaperCategorySlug('blendery-1402'), false);
});

// ---- 4. catalog page wiring -----------------------------------------------

test('FAQ: catalog page mounts FAQ + JSON-LD only for shpaleri% on page 1', () => {
  const page = src('app/catalog/page.tsx');
  assert.match(page, /import FaqSection from '@\/app\/components\/FaqSection'/);
  assert.match(page, /import FaqJsonLd from '@\/app\/components\/FaqJsonLd'/);
  // the gate: wallpaper subtree AND first page (clamped), nothing else
  assert.match(
    page,
    /page === 1 && isWallpaperCategorySlug\(filters\.categorySlug\)/,
    'FAQ gate must combine page 1 with the shpaleri% slug check'
  );
  assert.match(page, /showWallpaperFaq && <FaqJsonLd questions=\{WALLPAPER_FAQ\} \/>/);
  assert.match(page, /showWallpaperFaq && <FaqSection \/>/);
  // description block has its own page-1 gate and renders text children
  assert.match(
    page,
    /Boolean\(filters\.categorySlug\) && page === 1/,
    'category description gate must be page-1 only'
  );
  assert.match(page, /splitDescriptionParagraphs\(/);
  assert.match(page, /fetchCategoryDescription\(/);
  assert.doesNotMatch(
    page,
    /dangerouslySetInnerHTML/,
    'catalog page itself must never parse HTML'
  );
});

// ---- 5. sink invariant updated to 3 ----------------------------------------

test('INVARIANT: sink allowlist now counts three sanctioned sinks (incl. FaqJsonLd)', () => {
  const invariant = src('tests/product-description.test.ts');
  const allowlist = invariant.match(/const ALLOWED = \[([\s\S]*?)\];/);
  assert.ok(allowlist, 'ALLOWED array must exist');
  const body = allowlist[1] ?? '';
  const patterns = body.match(/\/[\w.\\$]+\/g?/g) ?? [];
  assert.equal(patterns.length, 3, `expected 3 allowlist patterns, got ${patterns.length}`);
  assert.ok(invariant.includes('/FaqJsonLd\\.tsx$/'), 'FaqJsonLd must be allowlisted');

  // and the app/ tree really holds exactly the allowlisted sinks
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
  const hits = walkApp(path.join(root, 'app')).filter((file) =>
    readFileSync(file, 'utf8').includes('dangerouslySetInnerHTML')
  );
  assert.equal(
    hits.length,
    3,
    `expected exactly 3 sink files, found: ${hits.map((h) => path.relative(root, h)).join(', ')}`
  );
});

// ---- bonus: pure paragraph splitter ----------------------------------------

test('description splitter: blank-line paragraphs, whitespace collapse, empty input', () => {
  assert.deepEqual(splitDescriptionParagraphs(null), []);
  assert.deepEqual(splitDescriptionParagraphs(undefined), []);
  assert.deepEqual(splitDescriptionParagraphs('   \n\t  '), []);
  assert.deepEqual(
    splitDescriptionParagraphs('Перший абзац.\n\nДругий абзац.'),
    ['Перший абзац.', 'Другий абзац.']
  );
  assert.deepEqual(
    splitDescriptionParagraphs('A.\n  \n  B.\r\n\r\nC.'),
    ['A.', 'B.', 'C.'],
    'blank lines with spaces and CRLF still split paragraphs'
  );
  assert.deepEqual(
    splitDescriptionParagraphs('Рядок один\nрядок два.'),
    ['Рядок один рядок два.'],
    'single newlines inside a paragraph collapse to spaces'
  );
});
