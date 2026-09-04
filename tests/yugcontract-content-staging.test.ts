/**
 * Unit tests for content staging reduction + image URL abstraction.
 * Pure functions — no network. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { reduceGoodsToStagedRows, isImportableExternalImageUrl } = await import(
  '../app/lib/yugcontract/content-staging.ts'
);
const { getPublicImageUrl, storagePathFromImageUrl } = await import(
  '../app/lib/supabase-storage.ts'
);

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://sb.example.com';

const GOOD_URL = 'https://b2b.yugcontract.ua/fileslibrary/products/a/b.jpg';

test('isImportableExternalImageUrl: valid https URL on the supplier host passes', () => {
  assert.deepEqual(isImportableExternalImageUrl(GOOD_URL), { ok: true });
  const http = isImportableExternalImageUrl('http://b2b.yugcontract.ua/x.png');
  assert.equal(http.ok, true);
});

test('isImportableExternalImageUrl: javascript:/data:/blob: schemes are rejected', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'blob:https://x.io/abc',
    'ftp://b2b.yugcontract.ua/a.jpg',
  ]) {
    const res = isImportableExternalImageUrl(url);
    assert.equal(res.ok, false, url);
    if (!res.ok) assert.match(res.reason, /схема|URL/);
  }
});

test('isImportableExternalImageUrl: foreign hosts are rejected', () => {
  const res = isImportableExternalImageUrl('https://evil.io/a.jpg');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /host/);
});

test('isImportableExternalImageUrl: pdf and extensionless files are rejected as images', () => {
  const pdf = isImportableExternalImageUrl('https://b2b.yugcontract.ua/docs/file.pdf');
  assert.equal(pdf.ok, false);
  if (!pdf.ok) assert.match(pdf.reason, /не дозволене/);

  const noExt = isImportableExternalImageUrl('https://b2b.yugcontract.ua/img/');
  assert.equal(noExt.ok, false);
});

test('getPublicImageUrl: storage path → Supabase public URL', () => {
  assert.equal(
    getPublicImageUrl('products/abc-uuid/main.jpg'),
    'https://sb.example.com/storage/v1/object/public/product_images/products/abc-uuid/main.jpg'
  );
});

test('getPublicImageUrl: external absolute URL returned unchanged', () => {
  assert.equal(getPublicImageUrl(GOOD_URL), GOOD_URL);
  assert.equal(
    getPublicImageUrl('http://b2b.yugcontract.ua/x.png'),
    'http://b2b.yugcontract.ua/x.png'
  );
});

test('storagePathFromImageUrl: external URLs yield empty path so delete flows skip Storage.remove()', () => {
  assert.equal(storagePathFromImageUrl(GOOD_URL), '');
  // existing behavior for our-bucket URLs and relative paths must not change
  assert.equal(
    storagePathFromImageUrl('https://sb.example.com/storage/v1/object/public/product_images/products/x/y.png'),
    'products/x/y.png'
  );
  assert.equal(storagePathFromImageUrl('products/x/y.png'), 'products/x/y.png');
});

test('reduceGoodsToStagedRows sanitizes description and filters pictures deterministically', async () => {
  const { normalizeContentGood } = await import(
    '../app/lib/yugcontract/content-dry-run.ts'
  );
  const raw = {
    id: '777',
    categoryId: 42,
    name: 'Товар',
    description:
      '  <p onclick="x">Опис</p><script>alert(1)</script><iframe src="https://evil.io"></iframe>  ',
    pictures: [
      GOOD_URL,
      'https://b2b.yugcontract.ua/docs/file.pdf', // rejected: extension
      'https://evil.io/a.jpg', // rejected: host
      'javascript:alert(1)', // rejected: scheme
    ],
    params: [
      { name: 'Матеріал', value: 'Сталь' },
      { name: 'Колір', value: 'синій' },
    ],
  };
  const good = normalizeContentGood(raw).good;
  assert.ok(good);

  const res = reduceGoodsToStagedRows([good]);
  assert.equal(res.rows.length, 1);
  const row = res.rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.yugcontract_id, '777');
  assert.equal(row.category_id, '42');
  // script content and iframe gone, handler gone, trimmed
  assert.equal(row.description, '<p>Опис</p>');
  assert.deepEqual(row.pictures, [GOOD_URL]);
  // specifications stay an ARRAY preserving supplier order
  assert.deepEqual(row.params, [
    { name: 'Матеріал', value: 'Сталь' },
    { name: 'Колір', value: 'синій' },
  ]);

  const reasons = Object.fromEntries(res.rejectedPictures.map((r) => [r.reason, r.count]));
  assert.equal(reasons['розширення .pdf не дозволене'], 1);
  assert.equal(reasons['чужий host evil.io'], 1);
  assert.equal(reasons['заборонена схема javascript:'], 1);
});

test('reduceGoodsToStagedRows keeps duplicate name+different value pairs (array format)', async () => {
  const { normalizeContentGood } = await import(
    '../app/lib/yugcontract/content-dry-run.ts'
  );
  const good = normalizeContentGood({
    id: '5',
    params: [
      { name: 'Матеріал', value: 'Нержавіюча сталь' },
      { name: 'Матеріал', value: 'Пластик' },
    ],
  }).good;
  assert.ok(good);
  const res = reduceGoodsToStagedRows([good]);
  assert.equal(res.rows.length, 1);
  assert.ok(res.rows[0] !== undefined);
  assert.deepEqual(res.rows[0].params, [
    { name: 'Матеріал', value: 'Нержавіюча сталь' },
    { name: 'Матеріал', value: 'Пластик' },
  ]);
});
