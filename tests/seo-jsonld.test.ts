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
