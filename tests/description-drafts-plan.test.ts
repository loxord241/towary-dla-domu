/**
 * Unit tests for the description-drafts pure layer (spec 2026-09-14,
 * Phase 2): target-segment filter, draft packaging from the Phase-1 core,
 * admin payload parsing. No network, no DB. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  DRAFT_SOURCE,
  DESCRIPTION_DRAFT_BATCH_SIZE,
  DESCRIPTION_DRAFT_PAGE_SIZE,
  isDraftTarget,
  buildDraftContent,
  parseDraftAction,
} = await import('../app/lib/description-drafts.ts');

const KETTLE_SPECS = [
  { name: 'Тип', value: 'Електрочайники' },
  { name: 'Потужність', value: '1850-2200 Вт' },
  { name: "Об'єм", value: '1,7 л' },
  { name: 'Матеріал корпусу', value: 'Скло' },
  { name: 'Захист від перегріву', value: 'Так' },
  { name: 'Довжина кабелю', value: '0.65 м' },
];

const PAN_SPECS = [
  { name: 'Тип', value: 'Сковороди' },
  { name: 'Матеріал', value: 'литий алюміній' },
  { name: 'Діаметр, см', value: '24' },
  { name: 'Антипригарне покриття', value: 'Так' },
];

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'uuid-1',
    name: 'Електрочайник GORENJE K17GXG',
    sku: 'YC-7023707',
    slug: 'elektrochainyk-gorenje-k17gxg',
    description: null,
    specifications: KETTLE_SPECS,
    brand_name: 'GORENJE',
    category_slug: 'elektrochainyky-1409',
    ...overrides,
  };
}

test('CONSTANTS: source tag, write window 200, admin page cap 50', () => {
  assert.equal(DRAFT_SOURCE, 'spec-generator-v1');
  assert.equal(DESCRIPTION_DRAFT_BATCH_SIZE, 200);
  assert.ok(DESCRIPTION_DRAFT_PAGE_SIZE <= 50);
  assert.equal(DESCRIPTION_DRAFT_PAGE_SIZE, 50);
});

test('isDraftTarget: empty/placeholder descriptions are targets, real text is not', () => {
  for (const empty of [null, undefined, '', '<p></p>', '<div><div></div></div>', '&nbsp; ', '   ']) {
    assert.equal(
      isDraftTarget(product({ description: empty })),
      true,
      `expected target for description=${JSON.stringify(empty)}`
    );
  }
  assert.equal(isDraftTarget(product({ description: '<p>Реальний опис</p>' })), false);
});

test('isDraftTarget: fewer than 3 sanitized specs disqualify (LEAD_MIN_SPECS)', () => {
  assert.equal(isDraftTarget(product({ specifications: KETTLE_SPECS.slice(0, 2) })), false);
  assert.equal(isDraftTarget(product({ specifications: [] })), false);
  assert.equal(isDraftTarget(product({ specifications: null })), false);
  // junk rows are sanitized away: 3 raw rows, 0 valid → not a target
  assert.equal(
    isDraftTarget(product({ specifications: [{ name: '', value: 'x' }, { name: 'a' }, 'junk'] })),
    false
  );
});

test('isDraftTarget: valid spec rows beyond LEAD_MIN_SPECS count as a target', () => {
  assert.equal(isDraftTarget(product({ specifications: KETTLE_SPECS.slice(0, 3) })), true);
});

test('buildDraftContent: appliance → list-format HTML wrapped description + lead', () => {
  const draft = buildDraftContent(product());
  assert.ok(draft, 'kettle fixture must produce a draft');
  assert.ok(draft.lead.length > 0, 'lead must be non-empty for the kettle');
  assert.match(draft.descriptionText, /^<ul><li>/);
  assert.match(draft.descriptionText, /<\/li><\/ul>$/);
  // Only core-produced content: the brand comes through the lead/name,
  // no invented marketing words.
  assert.doesNotMatch(draft.descriptionText, /найкращий|якісний|ідеальн/i);
});

test('buildDraftContent: cookware → paragraph format', () => {
  const draft = buildDraftContent(
    product({
      name: 'Сковорода IQ Be Hard глибока 24 см',
      sku: 'YC-7135808',
      specifications: PAN_SPECS,
      category_slug: 'skovoridky-ta-soteinyky-1367',
    })
  );
  assert.ok(draft);
  assert.match(draft.descriptionText, /^<p>.*<\/p>$/);
  assert.doesNotMatch(draft.descriptionText, /<li>/);
  // Unit relocated after the value, verbatim numbers (Phase-1 invariant);
  // sentence form capitalizes the first letter.
  assert.match(draft.descriptionText, /Діаметр 24 см/);
});

test('buildDraftContent: HTML-escapes feed values (products.description is an HTML column)', () => {
  const draft = buildDraftContent(
    product({
      specifications: [
        { name: 'Матеріал', value: 'АБС <пластик> & "преміум"' },
        { name: 'Потужність', value: '2000 Вт' },
        { name: "Об'єм", value: '1,7 л' },
      ],
    })
  );
  assert.ok(draft);
  assert.match(draft.descriptionText, /АБС &lt;пластик&gt; &amp; &quot;преміум&quot;/);
  assert.doesNotMatch(draft.descriptionText, /<пластик>/);
});

test('buildDraftContent: null when the core cannot voice ≥2 facts (no invented text)', () => {
  // «Тип» is dropped by the core, remaining rows are booleans without a
  // curated phrase → nothing voiceable.
  const draft = buildDraftContent(
    product({
      specifications: [
        { name: 'Тип', value: 'Електрочайники' },
        { name: 'Кришка', value: 'Ні' },
        { name: 'Індикація', value: 'Немає' },
      ],
    })
  );
  assert.equal(draft, null);
});

test('buildDraftContent: never returns a draft for a non-target product', () => {
  assert.equal(
    buildDraftContent(product({ description: '<p>Реальний опис</p>' })),
    null
  );
  assert.equal(
    buildDraftContent(product({ specifications: KETTLE_SPECS.slice(0, 2) })),
    null
  );
});

test('parseDraftAction: accepts only { id: uuid, action: approve|reject }', () => {
  const uuid = '0f0a6e1a-6f4e-4d5e-9a7b-1c2d3e4f5a6b';
  assert.deepEqual(parseDraftAction({ id: uuid, action: 'approve' }), {
    id: uuid,
    action: 'approve',
  });
  assert.deepEqual(parseDraftAction({ id: uuid, action: 'reject' }), {
    id: uuid,
    action: 'reject',
  });
  assert.equal(parseDraftAction({ id: uuid, action: 'publish' }), null);
  assert.equal(parseDraftAction({ id: uuid }), null);
  assert.equal(parseDraftAction({ id: 'not-a-uuid', action: 'approve' }), null);
  assert.equal(parseDraftAction({ action: 'approve' }), null);
  assert.equal(parseDraftAction(null), null);
  assert.equal(parseDraftAction('approve'), null);
  assert.equal(parseDraftAction(undefined), null);
});
