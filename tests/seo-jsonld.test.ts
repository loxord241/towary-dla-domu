/**
 * Product JSON-LD: ONLY real DB fields; offers gated on price>0;
 * aggregateRating gated on real published-review totals; serialization
 * escapes '<' so user/supplier strings can never close the script tag
 * (spec F of the SEO package). Type-only imports keep this module
 * Supabase-free and node:test-loadable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  stripHtmlToText,
  toIsoCurrency,
  buildProductJsonLd,
  buildProductBreadcrumbJsonLd,
  buildCatalogBreadcrumbJsonLd,
  buildOrganizationJsonLd,
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
    itemCondition: 'https://schema.org/NewCondition',
    // Key renamed to the canonical Google Merchant property 2026-09-16
    // (owner SEO package): `returnPolicy` was never read by Google.
    hasMerchantReturnPolicy: {
      '@type': 'MerchantReturnPolicy',
      applicableCountry: 'UA',
      returnPolicyCategory:
        'https://schema.org/MerchantReturnFiniteReturnWindow',
      merchantReturnDays: 14,
    },
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
    // Path form (SEO package 2026-09-13): the legacy query shape only
    // 308-redirects now, so the breadcrumb points straight at the path.
    'https://towary-dla-domu.com/catalog/plyty-kombinovani-1421'
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
    'https://towary-dla-domu.com/catalog/kat%20z%20probilom'
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
    { name: 'Дрібна побутова техніка', slug: 'mala-kukhonna-tekhnika-69' },
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
    ['Головна', 'Каталог', 'Дрібна побутова техніка']
  );
  assert.deepEqual(
    items.map((i) => i.position),
    [1, 2, 3]
  );
  assert.ok(items[2] !== undefined);
  assert.equal(
    items[2].item,
    `${SITE}/catalog/mala-kukhonna-tekhnika-69`
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

// ---- P2 (2026-09-12): Organization/LocalBusiness graph in the layout -------
// Pins read the actual shipped source (node:test, readFileSync) so the
// markup cannot silently regress. Facts only: both phones, both pickup
// addresses, the real legalName — and NO invented ratings/openingHours.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAYOUT = join(ROOT, 'app', 'layout.tsx');
const ORG_LD = join(ROOT, 'app', 'components', 'OrganizationJsonLd.tsx');

const layoutSource = () => readFileSync(LAYOUT, 'utf8');
const orgLdSource = () => readFileSync(ORG_LD, 'utf8');

test('OrgGraph: root layout renders OrganizationJsonLd on every page', () => {
  assert.match(layoutSource(), /OrganizationJsonLd/);
  const component = orgLdSource();
  assert.match(component, /application\/ld\+json/);
  assert.match(component, /buildOrganizationJsonLd/);
});

test('OrgGraph: builder emits the Organization facts, nothing invented', () => {
  const graph = buildOrganizationJsonLd(SITE)['@graph'] as {
    '@type': string;
    name?: string;
    telephone?: string[];
    email?: string;
    legalName?: string;
    address?: { streetAddress?: string };
  }[];
  const org = graph.find((n) => n['@type'] === 'Organization');
  const store = graph.find((n) => n['@type'] === 'Store');
  assert.ok(org && store);
  assert.equal(org.name, 'Товари для дому');
  assert.equal(org.legalName, 'ФОП Денисенко Світлана Юріївна');
  assert.deepEqual(org.telephone, ['+380973144221', '+380983584958']);
  assert.equal(org.email, 'magazinujut@gmail.com');
  assert.equal(org.address?.streetAddress, 'вул. Гетьмана Івана Мазепи, буд. 87А');
  const locations = (store as unknown as {
    location: { name: string; address: { streetAddress: string } }[];
  }).location;
  assert.equal(locations.length, 2);
  assert.deepEqual(
    locations.map((l) => l.address.streetAddress).sort(),
    // Обе точки на Мазепы (шпалерная улица переименована 2026-09-14).
    [
      'вул. Гетьмана Івана Мазепи, буд. 83А',
      'вул. Гетьмана Івана Мазепи, буд. 87А',
    ].sort()
  );
});

test('OrgGraph: WebSite node pins the Google site name (2026-09-16)', () => {
  const graph = buildOrganizationJsonLd(SITE)['@graph'] as {
    '@type': string;
    '@id'?: string;
    name?: string;
    url?: string;
    publisher?: { '@id': string };
  }[];
  const site = graph.find((n) => n['@type'] === 'WebSite');
  assert.ok(site, '@graph must contain a WebSite node');
  assert.equal(site['@id'], `${SITE}/#website`);
  assert.equal(site.url, `${SITE}/`);
  assert.equal(site.name, 'Товари для дому');
  assert.deepEqual(site.publisher, { '@id': `${SITE}/#organization` });
  // serializeJsonLd invariant untouched: the graph still round-trips with
  // every '<' escaped.
  const html = serializeJsonLd(buildOrganizationJsonLd(SITE));
  const parsed = JSON.parse(html) as { '@graph': { '@type': string }[] };
  assert.ok(parsed['@graph'].some((n) => n['@type'] === 'WebSite'));
  assert.ok(!/<\//.test(html), 'raw </ must never survive serialization');
});

test('OrgGraph: both phones and both pickup addresses survive serialization', () => {
  const html = serializeJsonLd(buildOrganizationJsonLd(SITE));
  for (const fact of [
    '+380973144221',
    '+380983584958',
    'вул. Гетьмана Івана Мазепи, буд. 87А',
    'вул. Гетьмана Івана Мазепи, буд. 83А',
    'Кривий Ріг',
    'magazinujut@gmail.com',
  ]) {
    assert.ok(html.includes(fact), `missing fact: ${fact}`);
  }
  const parsed = JSON.parse(html) as { '@graph': unknown[] };
  // 3 nodes since 2026-09-16: Organization + Store + WebSite (Google site
  // names, owner SEO package) — invariant changed by owner task, not broken.
  assert.equal(parsed['@graph'].length, 3);
});

test('OrgGraph: honesty — no invented ratings, openingHours or postal codes', () => {
  const html = serializeJsonLd(buildOrganizationJsonLd(SITE));
  for (const banned of [
    'aggregateRating',
    'ratingValue',
    'openingHours',
    'postalCode',
    'priceRange',
  ]) {
    assert.ok(!html.includes(banned), `must not invent ${banned}`);
  }
  assert.ok(!/rating/i.test(html));
});

test('Offer: itemCondition + 14-day hasMerchantReturnPolicy on every PDP offer (Merchant pins)', () => {
  const d = buildProductJsonLd(BASE, null, SITE)!;
  const offers = d.offers as Record<string, unknown>;
  assert.equal(offers.itemCondition, 'https://schema.org/NewCondition');
  // Canonical Google Merchant property name (renamed from `returnPolicy`
  // 2026-09-16, owner SEO package): present under the new key…
  assert.deepEqual(offers.hasMerchantReturnPolicy, {
    '@type': 'MerchantReturnPolicy',
    applicableCountry: 'UA',
    returnPolicyCategory:
      'https://schema.org/MerchantReturnFiniteReturnWindow',
    merchantReturnDays: 14,
  });
  // …and the old non-canonical key must be gone entirely.
  assert.ok(!('returnPolicy' in offers), 'legacy returnPolicy key must not survive');
  // PDP source still routes the builder payload through ProductJsonLd sink.
  const pdp = readFileSync(
    join(ROOT, 'app', 'product', '[slug]', 'page.tsx'),
    'utf8'
  );
  assert.match(pdp, /buildProductJsonLd/);
  assert.match(pdp, /ProductJsonLd/);
});
