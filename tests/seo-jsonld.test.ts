/**
 * Product JSON-LD: ONLY real DB fields; offers gated on price>0;
 * aggregateRating gated on real published-review totals; serialization
 * escapes '<' so user/supplier strings can never close the script tag
 * (spec F of the SEO package). Type-only imports keep this module
 * Supabase-free and node:test-loadable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtmlToText,
  toIsoCurrency,
  buildProductJsonLd,
  buildProductBreadcrumbJsonLd,
  buildCatalogBreadcrumbJsonLd,
  serializeJsonLd,
} from '../app/lib/schema-org.ts';

const BASE = {
  name: 'Плита комбінована BEKO FSM52334DAO',
  slug: 'plyta-beko-7081966',
  sku: '24010/106',
  price: 10999,
  old_price: null as number | null,
  currency: 'UAH',
  availability_status: 'in_stock',
  description: '<p>Гарна плита</p>',
  short_description: null as string | null,
  images: [{ image_url: 'https://b2b.yugcontract.ua/x.jpg' }],
  brand: { name: 'BEKO' },
};

test('JSONLD: stripHtmlToText drops tags, decodes common entities, caps', () => {
  assert.equal(stripHtmlToText('<p>Текст &amp; ще</p>'), 'Текст & ще');
  // tags become separators so table cells never glue together («20 л», не «20л»)
  assert.equal(stripHtmlToText('<div><b>x</b>y</div>'), 'x y');
  assert.equal(stripHtmlToText('abcdefgh', 4), 'abcd');
  assert.equal(stripHtmlToText(''), '');
});

test('JSONLD: currency normalization is factual, never invented', () => {
  assert.equal(toIsoCurrency('UAH'), 'UAH');
  assert.equal(toIsoCurrency('uah'), 'UAH');
  assert.equal(toIsoCurrency('₴'), 'UAH');
  assert.equal(toIsoCurrency('грн.'), 'UAH');
  assert.equal(toIsoCurrency(null), 'UAH');
});

test('JSONLD: happy path emits exactly the real fields', () => {
  const d = buildProductJsonLd(BASE, null, 'https://shop.example')!;
  assert.equal(d['@context'], 'https://schema.org');
  assert.equal(d['@type'], 'Product');
  assert.equal(d.name, BASE.name);
  assert.equal(d.sku, BASE.sku);
  assert.deepEqual(d.image, ['https://b2b.yugcontract.ua/x.jpg']);
  assert.equal(d.description, 'Гарна плита');
  assert.deepEqual(d.brand, { '@type': 'Brand', name: 'BEKO' });
  assert.deepEqual(d.offers, {
    '@type': 'Offer',
    url: 'https://shop.example/product/plyta-beko-7081966',
    price: '10999',
    priceCurrency: 'UAH',
    availability: 'https://schema.org/InStock',
  });
  assert.equal(d.aggregateRating, undefined);
});

test('JSONLD: availability maps the three real statuses only', () => {
  const mk = (availability_status: string) =>
    (
      buildProductJsonLd({ ...BASE, availability_status }, null, 'https://s.io')!
        .offers as { availability: string }
    ).availability;
  assert.equal(mk('in_stock'), 'https://schema.org/InStock');
  assert.equal(mk('out_of_stock'), 'https://schema.org/OutOfStock');
  assert.equal(mk('limited_stock'), 'https://schema.org/LimitedAvailability');
});

test('JSONLD: offers omitted when price is not a positive finite number', () => {
  for (const price of [0, -5, Number.NaN]) {
    const d = buildProductJsonLd({ ...BASE, price }, null, 'https://s.io')!;
    assert.equal(d.offers, undefined, `price=${price}`);
  }
});

test('JSONLD: aggregateRating only from real published totals', () => {
  const good = {
    total: 4,
    average: 4.5,
    distribution: [0, 0, 1, 0, 3] as [number, number, number, number, number],
  };
  assert.deepEqual(buildProductJsonLd(BASE, good, 'x')!.aggregateRating, {
    '@type': 'AggregateRating',
    ratingValue: '4.5',
    ratingCount: 4,
  });
  assert.equal(
    buildProductJsonLd(
      BASE,
      { total: 0, average: null, distribution: [0, 0, 0, 0, 0] },
      'x'
    )!.aggregateRating,
    undefined
  );
  assert.equal(buildProductJsonLd(BASE, null, 'x')!.aggregateRating, undefined);
});

test('JSONLD: serializer escapes < so supplier HTML cannot break out', () => {
  const evil = buildProductJsonLd(
    { ...BASE, name: 'x</script><script>alert(1)</script>' },
    null,
    'https://s.io'
  )!;
  const html = serializeJsonLd(evil);
  // A script element ends ONLY at '</script' — escaping every '<' kills
  // that sequence (and any '<!--' trick) while leaving '>' untouched.
  assert.ok(!/<\//.test(html), 'raw </ must never survive');
  assert.ok(!/<!--/.test(html), 'raw comment-open must never survive');
  assert.ok(html.includes('\\u003c/script>'), 'escaped form required');
});

test('JSONLD: missing brand/description/images simply drop fields', () => {
  const d = buildProductJsonLd(
    { ...BASE, brand: null, description: null, images: [] },
    null,
    'https://s.io'
  )!;
  assert.equal(d.brand, undefined);
  assert.equal(d.description, undefined);
  assert.equal(d.image, undefined);
});

// ---- P2-3 (2026-08-29): BreadcrumbList on product pages ---------------------

const BREADCRUMB_PRODUCT = {
  name: 'Плита комбінована BEKO FSM52334DAO',
  slug: 'plyta-beko-7081966',
};
const BREADCRUMB_CATEGORY = { name: 'Плити комбіновані', slug: 'plyty-kombinovani-1421' };
const SITE = 'https://towary-dla-domu.com';

test('BreadcrumbList: categorized product → 4 sequential items, real names', () => {
  const ld = buildProductBreadcrumbJsonLd(
    BREADCRUMB_PRODUCT,
    BREADCRUMB_CATEGORY,
    SITE
  ) as {
    '@type': string;
    itemListElement: { position: number; name: string; item: string }[];
  };
  assert.equal(ld['@type'], 'BreadcrumbList');
  const items = ld.itemListElement;
  assert.equal(items.length, 4);
  assert.ok(items[0] !== undefined && items[1] !== undefined && items[2] !== undefined && items[3] !== undefined);
  assert.deepEqual(
    items.map((i) => i.position),
    [1, 2, 3, 4]
  );
  assert.equal(items[0].name, 'Головна');
  assert.equal(items[1].name, 'Каталог');
  assert.equal(items[2].name, 'Плити комбіновані'); // REAL category name, not invented
  assert.equal(items[3].name, 'Плита комбінована BEKO FSM52334DAO');
});

test('BreadcrumbList: every URL is absolute; last item is the product URL', () => {
  const { itemListElement: items } = buildProductBreadcrumbJsonLd(
    BREADCRUMB_PRODUCT,
    BREADCRUMB_CATEGORY,
    SITE
  ) as { itemListElement: { item: string }[] };
  for (const i of items) {
    assert.match(i.item, /^https:\/\/towary-dla-domu\.com\//);
  }
  assert.ok(items[0] !== undefined && items[1] !== undefined && items[2] !== undefined && items[3] !== undefined);
  assert.equal(items[0].item, 'https://towary-dla-domu.com/');
  assert.equal(items[1].item, 'https://towary-dla-domu.com/catalog');
  assert.equal(
    items[2].item,
    'https://towary-dla-domu.com/catalog?category=plyty-kombinovani-1421'
  );
  assert.equal(
    items[3].item,
    'https://towary-dla-domu.com/product/plyta-beko-7081966'
  );
});

test('BreadcrumbList: category slug is URL-encoded like the visible nav link', () => {
  const { itemListElement: items } = buildProductBreadcrumbJsonLd(
    BREADCRUMB_PRODUCT,
    { name: 'Категорія/з "спецсимволами"', slug: 'kat z probilom' },
    SITE
  ) as { itemListElement: { item: string }[] };
  assert.ok(items[2] !== undefined);
  assert.equal(
    items[2].item,
    'https://towary-dla-domu.com/catalog?category=kat%20z%20probilom'
  );
});

test('BreadcrumbList: product without category drops the level, not the truth', () => {
  const ld = buildProductBreadcrumbJsonLd(
    BREADCRUMB_PRODUCT,
    null,
    SITE
  ) as { itemListElement: { position: number; name: string }[] };
  assert.deepEqual(
    ld.itemListElement.map((i) => i.position),
    [1, 2, 3]
  );
  assert.deepEqual(
    ld.itemListElement.map((i) => i.name),
    ['Головна', 'Каталог', 'Плита комбінована BEKO FSM52334DAO']
  );
});

test('BreadcrumbList: cyrillic/special chars survive serializeJsonLd', () => {
  const html = serializeJsonLd(
    buildProductBreadcrumbJsonLd(
      { name: 'Ніж TRAMONTINA "CENTURY" <поварський>', slug: 'nizh-24010' },
      BREADCRUMB_CATEGORY,
      SITE
    )
  );
  const parsed = JSON.parse(html) as {
    itemListElement: { name: string }[];
  };
  assert.equal(parsed.itemListElement.length, 4);
  const lastItem = parsed.itemListElement[3];
  assert.ok(lastItem !== undefined);
  assert.equal(
    lastItem.name,
    'Ніж TRAMONTINA "CENTURY" <поварський>'
  );
  assert.ok(!/<\//.test(html), 'raw </ must never survive serialization');
});

test('BreadcrumbList: Product JSON-LD builder output is untouched', () => {
  // regression pin: the two builders coexist, product payload unchanged
  const d = buildProductJsonLd(
    { ...BASE, images: [] },
    null,
    SITE
  ) as Record<string, unknown>;
  assert.equal(d['@type'], 'Product');
  assert.equal(d['@context'], 'https://schema.org');
});

// ---- catalog breadcrumb (category level, no extra DB reads)

test('JSONLD: catalog breadcrumb emits Головна → Каталог → Категорія', () => {
  const d = buildCatalogBreadcrumbJsonLd(
    { name: 'Господарчі товари', slug: 'hospodarchi-tovary-1451' },
    SITE
  );
  assert.equal(d['@type'], 'BreadcrumbList');
  const items = d.itemListElement as {
    position: number;
    name: string;
    item: string;
  }[];
  assert.deepEqual(
    items.map((i) => i.name),
    ['Головна', 'Каталог', 'Господарчі товари']
  );
  assert.deepEqual(
    items.map((i) => i.position),
    [1, 2, 3]
  );
  assert.ok(items[2] !== undefined);
  assert.equal(
    items[2].item,
    `${SITE}/catalog?category=hospodarchi-tovary-1451`
  );
});

test('JSONLD: catalog breadcrumb without category keeps two honest levels', () => {
  const d = buildCatalogBreadcrumbJsonLd(null, SITE);
  const items = d.itemListElement as { name: string }[];
  assert.deepEqual(
    items.map((i) => i.name),
    ['Головна', 'Каталог']
  );
});
