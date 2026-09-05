/**
 * Google Merchant feed builder (2026-09) — unit tests for the PURE builder
 * app/lib/merchant-feed.ts. The route (app/feeds/google-merchant.xml/route.ts)
 * only owns data access and is pinned here as source invariants, following
 * the established node:test pattern (JSX/route wiring is not executable in
 * node:test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  escapeXml,
  mapAvailability,
  buildMerchantItems,
  buildMerchantFeedXml,
  pickCategoryPath,
  GOOGLE_FEED_MAX_ITEMS,
  GOOGLE_TITLE_MAX_LENGTH,
  type MerchantFeedProductRow,
} from '../app/lib/merchant-feed.ts';
import { DU_REDIRECT_SLUGS } from '../app/lib/du-redirects.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routeSrc = () =>
  readFileSync(
    path.join(root, 'app/feeds/google-merchant.xml/route.ts'),
    'utf8'
  );

const baseRow = (): MerchantFeedProductRow => ({
  id: '11111111-1111-1111-1111-111111111111',
  slug: 'skovoroda-test-24',
  name: 'Сковорода "Bravo & Chef" 24 см',
  price: 1234.5,
  currency: 'UAH',
  availability_status: 'in_stock',
  description: '<p>Чугунная &amp; надёжная. "Отличный" выбор</p>',
  short_description: 'Короткое описание',
  brand_name: 'Bravo',
  image_url: 'https://example.supabase.co/storage/v1/object/public/product_images/products/1/main/img.jpg',
  category_path: 'Посуда / Сковороды',
});

// ---- escapeXml ----

test('FEED: escapeXml covers all five XML special characters', () => {
  assert.equal(
    escapeXml(`a&b<c>d"e'f`),
    'a&amp;b&lt;c&gt;d&quot;e&apos;f'
  );
});

test('FEED: escapeXml leaves Cyrillic and safe text untouched', () => {
  const text = 'Сковорода Bravo 24 см — чугун';
  assert.equal(escapeXml(text), text);
});

test('FEED: escapeXml escapes & first (no double-escaping)', () => {
  assert.equal(escapeXml('&amp;'), '&amp;amp;');
});

// ---- availability mapping ----

test('FEED: availability in_stock → in stock, everything else out of stock', () => {
  assert.equal(mapAvailability('in_stock'), 'in stock');
  assert.equal(mapAvailability('out_of_stock'), 'out of stock');
  // Unknown values must NEVER oversell — conservative mapping.
  assert.equal(mapAvailability('preorder'), 'out of stock');
  assert.equal(mapAvailability(''), 'out of stock');
});

// ---- buildMerchantItems: mapping ----

test('FEED: full row maps to a complete item with formatted price and link', () => {
  const [item] = buildMerchantItems([baseRow()], 'https://towary-dla-domu.com/');
  assert.ok(item);
  assert.equal(item.id, '11111111-1111-1111-1111-111111111111');
  assert.equal(item.title, 'Сковорода "Bravo & Chef" 24 см');
  // HTML stripped, entities decoded — the text lands RAW in the item and
  // gets XML-escaped only at serialization time.
  assert.equal(item.description, 'Чугунная & надёжная. "Отличный" выбор');
  assert.equal(item.link, 'https://towary-dla-domu.com/product/skovoroda-test-24');
  assert.equal(
    item.imageLink,
    'https://example.supabase.co/storage/v1/object/public/product_images/products/1/main/img.jpg'
  );
  assert.equal(item.availability, 'in stock');
  assert.equal(item.price, '1234.50 UAH');
  assert.equal(item.brand, 'Bravo');
  assert.equal(item.condition, 'new');
  assert.equal(item.identifierExists, 'no');
  assert.equal(item.productType, 'Посуда / Сковороды');
});

test('FEED: price formats with two decimals and ISO currency', () => {
  const row = { ...baseRow(), price: 999, currency: 'uah' };
  const [item] = buildMerchantItems([row], 'https://x.test');
  assert.equal(item?.price, '999.00 UAH');
});

// ---- buildMerchantItems: skips ----

test('FEED: item without any description text is skipped (Google rejects it)', () => {
  const rows: MerchantFeedProductRow[] = [
    { ...baseRow(), description: null, short_description: null },
    { ...baseRow(), description: '', short_description: '' },
    // HTML that strips to whitespace is still "no description".
    { ...baseRow(), description: '<br><p>&nbsp;</p>', short_description: null },
  ];
  assert.deepEqual(buildMerchantItems(rows, 'https://x.test'), []);
});

test('FEED: short_description is the fallback when description is empty', () => {
  const row = { ...baseRow(), description: null };
  const [item] = buildMerchantItems([row], 'https://x.test');
  assert.equal(item?.description, 'Короткое описание');
});

test('FEED: item without a resolvable absolute image is skipped', () => {
  const rows: MerchantFeedProductRow[] = [
    { ...baseRow(), image_url: null },
    { ...baseRow(), image_url: '' },
    // Relative storage paths must be absolutized by the data layer; a
    // relative value that leaked through is not a valid g:image_link.
    { ...baseRow(), image_url: 'products/1/main/img.jpg' },
  ];
  assert.deepEqual(buildMerchantItems(rows, 'https://x.test'), []);
});

test('FEED: item without a positive finite price is skipped', () => {
  const rows: MerchantFeedProductRow[] = [
    { ...baseRow(), price: 0 },
    { ...baseRow(), price: -5 },
    { ...baseRow(), price: Number.NaN },
  ];
  assert.deepEqual(buildMerchantItems(rows, 'https://x.test'), []);
});

test('FEED: _du redirect aliases are excluded, their base twins stay', () => {
  assert.ok(DU_REDIRECT_SLUGS.size > 0, 'allowlist must not be empty');
  const duSlug = [...DU_REDIRECT_SLUGS][0];
  assert.ok(duSlug, 'allowlist must contain at least one slug');
  const baseSlug = duSlug.replace(/_du$/, '');
  const rows: MerchantFeedProductRow[] = [
    { ...baseRow(), slug: duSlug },
    { ...baseRow(), slug: baseSlug },
  ];
  const items = buildMerchantItems(rows, 'https://x.test');
  assert.equal(items.length, 1);
  assert.equal(items[0]?.link.endsWith(`/${encodeURIComponent(baseSlug)}`), true);
});

test('FEED: title is trimmed and capped at 150 characters', () => {
  const longName = `  ${'Т'.repeat(200)}  `;
  const [item] = buildMerchantItems([{ ...baseRow(), name: longName }], 'https://x.test');
  assert.equal(item?.title.length, GOOGLE_TITLE_MAX_LENGTH);
  const shortName = '  Короткое имя  ';
  const [shortItem] = buildMerchantItems([{ ...baseRow(), name: shortName }], 'https://x.test');
  assert.equal(shortItem?.title, 'Короткое имя');
});

test('FEED: hard cap of 50000 items is applied deterministically', () => {
  assert.equal(GOOGLE_FEED_MAX_ITEMS, 50_000);
});

// ---- pickCategoryPath ----

const categories = [
  { id: 'root1', name: 'Посуда', parent_id: null, sort_order: 1 },
  { id: 'sub1', name: 'Сковороды', parent_id: 'root1', sort_order: 1 },
  { id: 'sub2', name: 'Кастрюли', parent_id: 'root1', sort_order: 2 },
  { id: 'root2', name: 'Техника', parent_id: null, sort_order: 2 },
];

test('FEED: product_type is the root-to-leaf name path joined with /', () => {
  assert.equal(pickCategoryPath(['sub1'], categories), 'Посуда / Сковороды');
});

test('FEED: multiple assignments pick deterministically by storefront order', () => {
  // sub1 (sort_order 1) beats sub2 (sort_order 2) regardless of input order.
  assert.equal(
    pickCategoryPath(['sub2', 'sub1'], categories),
    'Посуда / Сковороды'
  );
  assert.equal(
    pickCategoryPath(['sub1', 'sub2'], categories),
    'Посуда / Сковороды'
  );
});

test('FEED: unknown category ids are ignored; no known id → null', () => {
  assert.equal(pickCategoryPath(['ghost'], categories), null);
  assert.equal(
    pickCategoryPath(['ghost', 'sub1'], categories),
    'Посуда / Сковороды'
  );
  assert.equal(pickCategoryPath([], categories), null);
});

test('FEED: deep path walks up to the root; parent cycles do not hang', () => {
  const cyclic = [
    { id: 'a', name: 'A', parent_id: 'b', sort_order: 1 },
    { id: 'b', name: 'B', parent_id: 'a', sort_order: 1 },
  ];
  // Cycle: the walk stops after visiting each node once.
  assert.equal(pickCategoryPath(['a'], cyclic), 'B / A');
});

// ---- buildMerchantFeedXml: serialization ----

/** Minimal stack-based well-formedness checker (no XML parser in node:test). */
function assertWellFormedXml(input: string): void {
  // The <?xml … ?> declaration is not an element — strip it before scanning.
  const xml = input.replace(/^<\?xml[^?]*\?>\s*/, '');
  const tagRe = /<\/?([A-Za-z_][\w.:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->/g;
  const stack: string[] = [];
  let match: RegExpExecArray | null;
  let cursor = 0;
  while ((match = tagRe.exec(xml)) !== null) {
    // Anything between the last tag end and this tag must not contain raw <.
    const between = xml.slice(cursor, match.index);
    assert.equal(between.includes('<'), false, `raw '<' in text: ${JSON.stringify(between.slice(0, 80))}`);
    cursor = tagRe.lastIndex;
    if (match[0].startsWith('<!--') || match[0].endsWith('/>')) continue;
    const full: string = match[0];
    const name: string = match[1] ?? '';
    if (full.startsWith('</')) {
      const open = stack.pop();
      assert.equal(open, name, `mismatched closing tag: expected </${open}> got </${name}>`);
    } else {
      stack.push(name);
    }
  }
  const tail = xml.slice(cursor);
  assert.equal(tail.includes('<'), false, `raw '<' after last tag: ${JSON.stringify(tail.slice(0, 80))}`);
  assert.deepEqual(stack, [], 'unclosed tags remain');
}

test('FEED: XML document is well-formed with the g: namespace', () => {
  const xml = buildMerchantFeedXml(
    buildMerchantItems([baseRow()], 'https://towary-dla-domu.com'),
    { channelTitle: 'Товари для дому — feed' }
  );
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<rss version="2.0" xmlns:g="http:\/\/base\.google\.com\/ns\/1\.0">/);
  assert.match(xml, /<g:id>11111111-1111-1111-1111-111111111111<\/g:id>/);
  assert.match(xml, /<g:availability>in stock<\/g:availability>/);
  assert.match(xml, /<g:price>1234\.50 UAH<\/g:price>/);
  assert.match(xml, /<g:condition>new<\/g:condition>/);
  assert.match(xml, /<g:identifier_exists>no<\/g:identifier_exists>/);
  assert.match(xml, /<\/rss>$/);
  assertWellFormedXml(xml);
});

test('FEED: XML-escaping at serialization — & " < > and quotes survive round trip', () => {
  const xml = buildMerchantFeedXml(
    buildMerchantItems([baseRow()], 'https://x.test'),
    {}
  );
  assert.match(xml, /<g:title>Сковорода &quot;Bravo &amp; Chef&quot; 24 см<\/g:title>/);
  assert.match(xml, /<g:description>Чугунная &amp; надёжная\. &quot;Отличный&quot; выбор<\/g:description>/);
  // No raw '<script>' can leak from stored names (descriptions are
  // HTML-stripped earlier — see the strip test above).
  const evil = {
    ...baseRow(),
    name: '</item><script>alert(1)</script>',
  } satisfies MerchantFeedProductRow;
  const evilXml = buildMerchantFeedXml(buildMerchantItems([evil], 'https://x.test'), {});
  assert.equal(evilXml.includes('</item><script>'), false);
  assert.match(evilXml, /&lt;\/item&gt;&lt;script&gt;/);
  assertWellFormedXml(evilXml);
});

test('FEED: optional fields are omitted; comment dashes are sanitized', () => {
  const row: MerchantFeedProductRow = {
    ...baseRow(),
    brand_name: null,
    category_path: null,
  };
  const xml = buildMerchantFeedXml(buildMerchantItems([row], 'https://x.test'), {
    comment: 'degraded -- mode -- test',
  });
  assert.equal(xml.includes('<g:brand>'), false);
  assert.equal(xml.includes('<g:product_type>'), false);
  assert.match(xml, /<!-- degraded - mode - test -->/);
  assertWellFormedXml(xml);
});

test('FEED: empty item list still produces a valid (degraded) feed', () => {
  const xml = buildMerchantFeedXml([], { comment: 'read failed' });
  assert.match(xml, /<channel>/);
  assert.equal(xml.includes('<item>'), false);
  assertWellFormedXml(xml);
});

// ---- route wiring (source invariants) ----

test('FEED: route keeps the storefront eligibility join, ISR window and degradation', () => {
  const src = routeSrc();
  // Same eligibility join as app/sitemap.ts.
  assert.match(src, /product_images!inner/);
  assert.match(src, /\.eq\('is_active', true\)/);
  assert.match(src, /\.order\('id', \{ ascending: true \}\)/);
  assert.match(src, /collectPaged/);
  // Hourly ISR + public URL; never a raw 500.
  assert.match(src, /export const revalidate = 3600/);
  assert.match(src, /'Content-Type': 'application\/xml; charset=utf-8'/);
  assert.match(src, /status: 200/);
  assert.match(src, /getPublicImageUrl/);
  // Service key must never appear.
  assert.equal(src.includes('SERVICE_ROLE'), false);
  assert.equal(src.includes('service_role'), false);
});
