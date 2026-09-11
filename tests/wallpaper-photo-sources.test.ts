/**
 * Task 8 (wallpapers import): фото-пайплайн — pure-матчеры и хелперы
 * (app/lib/wallpapers/photo-sources.ts) + CLI-контракт
 * (scripts/wallpaper-photos.ts: --index / --plan / --run).
 *
 * Фикстуры-URL — реальные примеры из research плана
 * (docs/superpowers/plans/2026-09-10-wallpapers-import.md, Task 8):
 * v277-6647-04 (slav), bravo-86000br90 (epicentr), хеш-суффиксы -01f4bd.
 *
 * Сетевых вызовов и обращений к БД/Storage НЕТ: fetch и supabase-клиент
 * инжектируются (CLI deps DI-паттерн), кэш — во временных папках os.tmpdir(),
 * supabase — in-memory fake (runtime-тесты run()-логики: slav-хотлинки
 * (ТОЛЬКО main — «1 фото = 1 карточка»), epicentr-копии в Storage,
 * 23505 → no-op, идемпотентный повтор, пагинация; --specs: UPDATE
 * products.specifications payload, --dry → 0 записей, throttle,
 * пустые характеристики → товар не тронут).
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_PRIORITY,
  SOURCE_SITEMAPS,
  detectImageMime,
  matchSourceUrl,
  matchSourceByUrl,
  normalizeArticleToken,
  parseSlavCharacteristics,
  extractPageImages,
  extractSitemapUrls,
  MAX_TEXTURES,
  pickMainAndTextures,
  planPhotoCoverage,
  SLAV_ROOMS_SPEC_NAME,
  unionCoveredCodes,
  wallpaperSkuForItem,
  type PhotoItem,
  type PhotoSource,
} from '../app/lib/wallpapers/photo-sources.ts';
import {
  HttpFetchError,
  articleTokensForItem,
  MAX_IMAGE_BYTES,
  parseArgs,
  run,
  runPhotosCli,
  runSpecs,
  type RunTotals,
  type SpecsRunTotals,
} from '../scripts/wallpaper-photos.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// matchSourceUrl — строгий токен-матч на реальных URL
// ---------------------------------------------------------------------------

const SLAV_URL = 'https://oboi-slav-oboi.com/ua/v277-6647-04/';
const EPICENTR_URL =
  'https://epicentrk.ua/ua/shop/oboi-bravo-86000br90-1-06x10-05-m.html';
const HASH_SUFFIX_URL = 'https://shpalery-ua.com/ua/p/v76.4-svezhest-5190-01-01f4bd';

test('photo-sources: slav slug v277-6647-04 matches token 6647-04', () => {
  assert.equal(matchSourceUrl(SLAV_URL, ['6647-04']), true);
});

test('photo-sources: epicentr product page matches alnum token 86000br90', () => {
  assert.equal(matchSourceUrl(EPICENTR_URL, ['86000br90']), true);
});

test('photo-sources: hash-suffixed slug matches token before the hash', () => {
  assert.equal(matchSourceUrl(HASH_SUFFIX_URL, ['5190-01']), true);
});

test('photo-sources: URL is matched case-insensitively (lowercased)', () => {
  assert.equal(
    matchSourceUrl(EPICENTR_URL.toUpperCase(), ['86000br90']),
    true,
  );
  assert.equal(matchSourceUrl(SLAV_URL, ['6647-04'.toUpperCase()]), true);
});

test('photo-sources: token "531" inside "5310" does NOT match (digit guard)', () => {
  assert.equal(
    matchSourceUrl('https://styleo.com.ua/p/5310-02-shpaleri', ['531']),
    false,
  );
});

test('photo-sources: partial token followed/preceded by a digit does NOT match', () => {
  // 6647-0|4 — за токеном идёт цифра
  assert.equal(matchSourceUrl(SLAV_URL, ['6647-0']), false);
  // 4|6647-04 — перед токеном цифра
  assert.equal(
    matchSourceUrl('https://oboi-slav-oboi.com/ua/v277-46647-04/', ['6647-04']),
    false,
  );
  // 5190-0|1f4bd — за токеном цифра
  assert.equal(matchSourceUrl(HASH_SUFFIX_URL, ['5190-0']), false);
  // буквы после цифры в alnum-токене: 86000br9|0
  assert.equal(matchSourceUrl(EPICENTR_URL, ['86000br9']), false);
});

test('photo-sources: token bounded by non-digits (start/end/path) matches', () => {
  assert.equal(matchSourceUrl('https://shpaleru.com.ua/product/531', ['531']), true);
  assert.equal(matchSourceUrl('https://x.com/531?utm=1', ['531']), true);
  // вариантный суффикс -2 (тот же дизайн) — легальное совпадение
  assert.equal(matchSourceUrl('https://oboi-slav-oboi.com/ua/v277-6647-04-2/', ['6647-04']), true);
});

test('photo-sources: empty token list / empty token never matches', () => {
  assert.equal(matchSourceUrl(SLAV_URL, []), false);
  assert.equal(matchSourceUrl(SLAV_URL, ['']), false);
  assert.equal(matchSourceUrl(SLAV_URL, ['', '  ']), false);
});

test('photo-sources: absent token does not match', () => {
  assert.equal(matchSourceUrl(SLAV_URL, ['9999-99']), false);
});

test('photo-sources: matchSourceByUrl returns first matching URL or null', () => {
  const urls = [
    'https://a.example.com/p/1111-01/',
    SLAV_URL,
    'https://c.example.com/p/6647-04-2/',
  ];
  assert.equal(matchSourceByUrl(urls, ['6647-04']), SLAV_URL);
  assert.equal(matchSourceByUrl(urls, ['nope']), null);
  assert.equal(matchSourceByUrl(urls, []), null);
});

// ---------------------------------------------------------------------------
// SOURCE_PRIORITY / SOURCE_SITEMAPS
// ---------------------------------------------------------------------------

test('photo-sources: SOURCE_PRIORITY order slav -> epicentr -> shpalery-ua -> styleo -> shpaleru', () => {
  assert.deepEqual([...SOURCE_PRIORITY], [
    'slav',
    'epicentr',
    'shpalery-ua',
    'styleo',
    'shpaleru',
  ]);
});

test('photo-sources: SOURCE_SITEMAPS covers exactly the priority sources with https .xml URLs', () => {
  assert.deepEqual(Object.keys(SOURCE_SITEMAPS).sort(), [...SOURCE_PRIORITY].sort());
  for (const source of SOURCE_PRIORITY) {
    const sitemaps = SOURCE_SITEMAPS[source] ?? [];
    assert.ok(sitemaps.length >= 1, `${source} must declare >= 1 sitemap`);
    for (const url of sitemaps) {
      assert.match(url, /^https:\/\//, `${source} sitemap must be https`);
      assert.match(url, /\.xml$/, `${source} sitemap must be .xml`);
    }
  }
  // захардкоженные адреса из плана
  assert.deepEqual(SOURCE_SITEMAPS.slav, [
    'https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml',
  ]);
  assert.deepEqual(SOURCE_SITEMAPS.epicentr, [
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua.xml',
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua_000.xml',
  ]);
  assert.deepEqual(SOURCE_SITEMAPS['shpalery-ua'], [
    'https://shpalery-ua.com/content/export/shpalery-ua.com/catalog-sitemap-01.xml',
    'https://shpalery-ua.com/content/export/shpalery-ua.com/catalog-sitemap-02.xml',
  ]);
  assert.deepEqual(SOURCE_SITEMAPS.styleo, [
    'https://styleo.com.ua/catalog-sitemap-01.xml',
    'https://styleo.com.ua/catalog-sitemap-02.xml',
  ]);
  assert.deepEqual(SOURCE_SITEMAPS.shpaleru, [
    'https://shpaleru.com.ua/sitemap_products-0.xml',
  ]);
});

// ---------------------------------------------------------------------------
// normalizeArticleToken
// ---------------------------------------------------------------------------

test('photo-sources: normalizeArticleToken trims and lowercases, null on empty', () => {
  assert.equal(normalizeArticleToken('  6647-04 '), '6647-04');
  assert.equal(normalizeArticleToken('86000BR90'), '86000br90');
  assert.equal(normalizeArticleToken(''), null);
  assert.equal(normalizeArticleToken('   '), null);
});

// ---------------------------------------------------------------------------
// extractSitemapUrls
// ---------------------------------------------------------------------------

test('photo-sources: extractSitemapUrls pulls <loc>, trims, dedupes, filters non-http, decodes &amp;', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>  ${SLAV_URL}  </loc></url>
  <url><loc>${SLAV_URL}</loc></url>
  <url><loc>https://oboi-slav-oboi.com/ua/cat/a?utm=1&amp;utm2=2</loc></url>
  <url><loc>/relative/not-absolute</loc></url>
  <url><lastmod>2026-09-10</lastmod></url>
</urlset>`;
  assert.deepEqual(extractSitemapUrls(xml), [
    SLAV_URL,
    'https://oboi-slav-oboi.com/ua/cat/a?utm=1&utm2=2',
  ]);
});

test('photo-sources: extractSitemapUrls tolerates namespaced <sm:loc> in sitemap indexes', () => {
  const xml = `<sitemapindex>
  <sm:loc>https://cdn.example.com/sitemaps/sm-1.xml</sm:loc>
  <loc>https://cdn.example.com/sitemaps/sm-2.xml</loc>
</sitemapindex>`;
  assert.deepEqual(extractSitemapUrls(xml), [
    'https://cdn.example.com/sitemaps/sm-1.xml',
    'https://cdn.example.com/sitemaps/sm-2.xml',
  ]);
});

// ---------------------------------------------------------------------------
// pickMainAndTextures
// ---------------------------------------------------------------------------

test('photo-sources: pickMainAndTextures — null on empty/blank input', () => {
  assert.equal(pickMainAndTextures([]), null);
  assert.equal(pickMainAndTextures(['', '   ']), null);
});

test('photo-sources: main = first URL, textures = the rest (dedup keeps first occurrence)', () => {
  const result = pickMainAndTextures([
    'https://cdn/u1.jpg',
    'https://cdn/u1.jpg',
    'https://cdn/u2.jpg',
    'https://cdn/u3.jpg',
    'https://cdn/u2.jpg',
  ]);
  assert.deepEqual(result, {
    main: 'https://cdn/u1.jpg',
    textures: ['https://cdn/u2.jpg', 'https://cdn/u3.jpg'],
  });
});

test(`photo-sources: textures capped at ${12} (MAX_TEXTURES)`, () => {
  assert.equal(MAX_TEXTURES, 12);
  const urls = Array.from({ length: 15 }, (_, i) => `https://cdn/u${i + 1}.jpg`);
  const result = pickMainAndTextures(urls);
  assert.ok(result !== null);
  assert.equal(result.main, 'https://cdn/u1.jpg');
  assert.equal(result.textures.length, MAX_TEXTURES);
  assert.deepEqual(result.textures, urls.slice(1, 1 + MAX_TEXTURES));
});

test('photo-sources: all-duplicate list gives main with zero textures', () => {
  assert.deepEqual(pickMainAndTextures(['https://cdn/u1.jpg', 'https://cdn/u1.jpg']), {
    main: 'https://cdn/u1.jpg',
    textures: [],
  });
});

// ---------------------------------------------------------------------------
// extractPageImages — <img src> страницы товара slav
// ---------------------------------------------------------------------------

const SLAV_PAGE_HTML = `<!doctype html>
<html><body>
  <div class="product-gallery">
    <img src="https://oboi-slav-oboi.com/assets/products/2746/main.jpg" alt="шпалери">
    <img class="thumb" src='/assets/products/2746/tex-1.jpg'>
    <img src="//oboi-slav-oboi.com/assets/products/2746/tex-2.jpg">
    <img src="/assets/products/2746/tex-1.jpg">
    <img src="/assets/products/2746/tex-3.jpg?w=200&amp;h=400">
    <img src="/images/logo.png">
    <img data-src="/assets/products/2746/lazy.jpg">
    <img src="data:image/gif;base64,R0lGOD">
  </div>
</body></html>`;

test('photo-sources: extractPageImages — main + текстуры, абсолютизация, дедуп, &amp;', () => {
  assert.deepEqual(extractPageImages(SLAV_PAGE_HTML), [
    'https://oboi-slav-oboi.com/assets/products/2746/main.jpg',
    'https://oboi-slav-oboi.com/assets/products/2746/tex-1.jpg',
    'https://oboi-slav-oboi.com/assets/products/2746/tex-2.jpg',
    'https://oboi-slav-oboi.com/assets/products/2746/tex-3.jpg?w=200&h=400',
  ]);
});

test('photo-sources: extractPageImages — только <img src> (data-src игнор), без паттерна -> []', () => {
  assert.deepEqual(extractPageImages('<div><img data-src="/assets/products/1/a.jpg"></div>'), []);
  assert.deepEqual(extractPageImages('<div><img src="/images/logo.png"></div>'), []);
  assert.deepEqual(extractPageImages(''), []);
});

test('photo-sources: extractPageImages — fancybox <a href> + bare-relative (реальная структура slav, 2026-09-10)', () => {
  const html = '<a href="assets/products/8693/0150066001711094792.jpg" data-fancybox="gallery"></a>' +
    '<a href="/assets/products/8689/0526847001711094738.jpg"></a>' +
    '<img src="assets/products/8690/0913507001711094750.jpg">';
  assert.deepEqual(extractPageImages(html), [
    'https://oboi-slav-oboi.com/assets/products/8693/0150066001711094792.jpg',
    'https://oboi-slav-oboi.com/assets/products/8689/0526847001711094738.jpg',
    'https://oboi-slav-oboi.com/assets/products/8690/0913507001711094750.jpg',
  ]);
  // data-src по-прежнему игнорируется (guard lookbehind)
  assert.deepEqual(extractPageImages('<div><img data-src="/assets/products/1/a.jpg"></div>'), []);
});

test('photo-sources: extractPageImages + pickMainAndTextures — дедуп и лимит 12 текстур', () => {
  const imgs = Array.from(
    { length: 20 },
    (_, i) => `<img src="/assets/products/9/t${i + 1}.jpg">`,
  ).join('\n');
  const picked = pickMainAndTextures(extractPageImages(`<html>${imgs}</html>`));
  assert.ok(picked !== null);
  assert.equal(picked.main, 'https://oboi-slav-oboi.com/assets/products/9/t1.jpg');
  assert.equal(picked.textures.length, MAX_TEXTURES);
  assert.equal(
    picked.textures[MAX_TEXTURES - 1],
    'https://oboi-slav-oboi.com/assets/products/9/t13.jpg',
  );
});

// ---------------------------------------------------------------------------
// parseSlavCharacteristics — характеристики страницы товара slav (--specs)
// ---------------------------------------------------------------------------

// РЕАЛЬНЫЙ фрагмент страницы oboi-slav-oboi.com (research 2026-09-10):
// таблица характеристик + чипы-фильтры помещений.
const SLAV_SPECS_FRAGMENT =
  '<div class="table-item"><div class="table-item--caption">Довжина</div>' +
  '<div class="table-item--text">10.05 м</div></div>' +
  '<div class="table-item"><div class="table-item--caption">Ширина</div>' +
  '<div class="table-item--text">0.53 м</div></div>' +
  '<div class="table-item"><div class="table-item--caption">Основа</div>' +
  '<div class="table-item--text">Паперова</div></div>';
const SLAV_ROOMS_FRAGMENT =
  '<div class="filters"><a href="https://oboi-slav-oboi.com/ua/catalog/f/tip-pomeshheniya=gostinnaya/" ' +
  'class="item-filter">Вітальня<i class="icon icon-bed"></i></a> ' +
  '<a href="https://oboi-slav-oboi.com/ua/catalog/f/tip-pomeshheniya=spalnya/" class="item-filter">Спальня<i></i></a></div>';

test('photo-sources: parseSlavCharacteristics — реальный фрагмент: пары + Приміщення', () => {
  assert.deepEqual(parseSlavCharacteristics(SLAV_SPECS_FRAGMENT + SLAV_ROOMS_FRAGMENT), [
    { name: 'Довжина', value: '10.05 м' },
    { name: 'Ширина', value: '0.53 м' },
    { name: 'Основа', value: 'Паперова' },
    { name: 'Приміщення', value: 'Вітальня, Спальня' },
  ]);
});

test('photo-sources: parseSlavCharacteristics — без чипов помещений нет записи Приміщення', () => {
  assert.deepEqual(parseSlavCharacteristics(SLAV_SPECS_FRAGMENT), [
    { name: 'Довжина', value: '10.05 м' },
    { name: 'Ширина', value: '0.53 м' },
    { name: 'Основа', value: 'Паперова' },
  ]);
  assert.equal(SLAV_ROOMS_SPEC_NAME, 'Приміщення');
});

test('photo-sources: parseSlavCharacteristics — только помещения -> одна запись', () => {
  assert.deepEqual(parseSlavCharacteristics(SLAV_ROOMS_FRAGMENT), [
    { name: 'Приміщення', value: 'Вітальня, Спальня' },
  ]);
});

test('photo-sources: parseSlavCharacteristics — пусто/без разметки -> []', () => {
  assert.deepEqual(parseSlavCharacteristics(''), []);
  assert.deepEqual(parseSlavCharacteristics('<div>ничего релевантного</div>'), []);
  // caption без text-сиблинга не склеивается со СЛЕДУЮЩЕЙ парой
  assert.deepEqual(
    parseSlavCharacteristics(
      '<div class="table-item--caption">Основа</div>' +
        '<div class="table-item"><div class="table-item--caption">Ширина</div>' +
        '<div class="table-item--text">0.53 м</div></div>',
    ),
    [{ name: 'Ширина', value: '0.53 м' }],
  );
});

test('photo-sources: parseSlavCharacteristics — дедуп по name, первое значение побеждает', () => {
  const html =
    '<div class="table-item--caption">Ширина</div><div class="table-item--text">0.53 м</div>' +
    '<div class="table-item--caption">Ширина</div><div class="table-item--text">1.06 м</div>';
  assert.deepEqual(parseSlavCharacteristics(html), [{ name: 'Ширина', value: '0.53 м' }]);
  // повтор чипа помещения не дублируется в join
  const dupRoom = SLAV_ROOMS_FRAGMENT + SLAV_ROOMS_FRAGMENT;
  assert.deepEqual(parseSlavCharacteristics(dupRoom), [
    { name: 'Приміщення', value: 'Вітальня, Спальня' },
  ]);
});

test('photo-sources: parseSlavCharacteristics — trim и декод &amp;', () => {
  const html =
    '<div class="table-item"><div class="table-item--caption"> Колекція </div>' +
    '<div class="table-item--text"> Nika &amp; Sons </div></div>' +
    '<a href="/ua/catalog/f/tip-pomeshheniya=dityacha/" class="item-filter">Дитяча &amp; ігрова<i></i></a>';
  assert.deepEqual(parseSlavCharacteristics(html), [
    { name: 'Колекція', value: 'Nika & Sons' },
    { name: 'Приміщення', value: 'Дитяча & ігрова' },
  ]);
});

// ---------------------------------------------------------------------------
// detectImageMime — magic bytes (jpeg/png/webp)
// ---------------------------------------------------------------------------

test('photo-sources: detectImageMime — jpeg/png/webp по magic bytes, мусор/HTML -> null', () => {
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'image/jpeg');
  assert.equal(
    detectImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])),
    'image/png',
  );
  assert.equal(
    detectImageMime(
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    ),
    'image/webp',
  );
  assert.equal(detectImageMime(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  assert.equal(detectImageMime(Uint8Array.from([0xff])), null);
  assert.equal(
    detectImageMime(new Uint8Array(new TextEncoder().encode('<!doctype html><html>'))),
    null,
  );
});

// ---------------------------------------------------------------------------
// wallpaperSkuForItem — точная копия sku-правила импортера (import-plan)
// ---------------------------------------------------------------------------

test('photo-sources: wallpaperSkuForItem зеркалит sku-правило import-plan', () => {
  assert.equal(wallpaperSkuForItem({ code: '1', name: 'x', article: 'SP 531-34' }), 'wc-sp531-34');
  assert.equal(
    wallpaperSkuForItem({ code: '1', name: 'x', article: ' 86000BR90 ' }),
    'wc-86000br90',
  );
  assert.equal(wallpaperSkuForItem({ code: 'ABC', name: 'x', article: null }), 'wc-xABC');
  assert.equal(wallpaperSkuForItem({ code: 'ABC', name: 'x' }), 'wc-xABC');
  // пробельный артикул = отсутствие артикула (fallback на код), как в import-plan
  assert.equal(wallpaperSkuForItem({ code: '7', name: 'x', article: '   ' }), 'wc-x7');
  assert.equal(wallpaperSkuForItem({ code: ' 7 ', name: 'x', article: null }), 'wc-x7');
});

// ---------------------------------------------------------------------------
// planPhotoCoverage / unionCoveredCodes
// ---------------------------------------------------------------------------

const ITEMS: PhotoItem[] = [
  { code: '100', name: 'шпалери 6647-04', article: '6647-04' },
  { code: '200', name: 'Браво темні', article: '86000BR90' },
  { code: '300', name: 'шпалери сірі', article: null },
];

function stubTokensOf(item: PhotoItem): string[] {
  const byCode: Record<string, string[]> = {
    '100': ['6647-04'],
    '200': ['86000br90'],
    '300': ['531'],
  };
  return byCode[item.code] ?? [];
}

const CACHES = {
  slav: [SLAV_URL, 'https://oboi-slav-oboi.com/ua/v278-1234-56/'],
  epicentr: [EPICENTR_URL],
  // токен 531 против 5310-01 — НЕ должен совпасть (цифровой guard)
  styleo: ['https://styleo.com.ua/p/5310-01-shpaleri'],
};

test('photo-sources: planPhotoCoverage reports per-source coverage in priority order', () => {
  const covs = planPhotoCoverage(ITEMS, CACHES, stubTokensOf);
  assert.deepEqual(
    covs.map((c) => c.source),
    [...SOURCE_PRIORITY],
  );

  const slav = covs.find((c) => c.source === 'slav');
  assert.ok(slav);
  assert.equal(slav.indexUrls, 2);
  assert.equal(slav.matchedItems, 1);
  assert.equal(slav.matchedUrls, 1);
  assert.deepEqual(slav.matchedCodes, ['100']);
  assert.deepEqual(slav.samples, [{ code: '100', url: SLAV_URL }]);

  const epicentr = covs.find((c) => c.source === 'epicentr');
  assert.ok(epicentr);
  assert.equal(epicentr.matchedItems, 1);
  assert.deepEqual(epicentr.matchedCodes, ['200']);

  // 531 внутри 5310-01 — false positive исключён
  const styleo = covs.find((c) => c.source === 'styleo');
  assert.ok(styleo);
  assert.equal(styleo.matchedItems, 0);
  assert.equal(styleo.matchedUrls, 0);
  assert.deepEqual(styleo.samples, []);

  // источники без кэша всё равно в отчёте
  for (const source of ['shpalery-ua', 'shpaleru'] as const) {
    const cov = covs.find((c) => c.source === source);
    assert.ok(cov);
    assert.equal(cov.indexUrls, 0);
    assert.equal(cov.matchedItems, 0);
  }
});

test('photo-sources: planPhotoCoverage honors sampleSize option', () => {
  const covs = planPhotoCoverage(ITEMS, CACHES, stubTokensOf, { sampleSize: 0 });
  const slav = covs.find((c) => c.source === 'slav');
  assert.ok(slav);
  assert.equal(slav.samples.length, 0);
  assert.equal(slav.matchedItems, 1); // счётчики не зависят от samples
});

test('photo-sources: unionCoveredCodes merges matched codes across sources', () => {
  const covs = planPhotoCoverage(ITEMS, CACHES, stubTokensOf);
  assert.deepEqual([...unionCoveredCodes(covs)].sort(), ['100', '200']);
});

// ---------------------------------------------------------------------------
// CLI: articleTokensForItem (article-first, fallback -> parseArticleTokens)
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: articleTokensForItem prefers the article column', () => {
  assert.deepEqual(articleTokensForItem({ code: '1', name: 'бла', article: '6647-04' }), [
    '6647-04',
  ]);
  assert.deepEqual(
    articleTokensForItem({ code: '1', name: 'бла', article: ' 86000BR90 ' }),
    ['86000br90'],
  );
});

test('wallpaper-photos CLI: articleTokensForItem falls back to parseArticleTokens(name)', () => {
  assert.deepEqual(
    articleTokensForItem({ code: '1', name: '6647-04 шпалери,53см*10м', article: null }),
    ['6647-04'],
  );
  assert.deepEqual(
    articleTokensForItem({ code: '1', name: '86000BR90 Браво темні, шпалери 1,06*10м' }),
    ['86000br90'],
  );
});

// ---------------------------------------------------------------------------
// CLI: parseArgs
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: parseArgs --index <source>', () => {
  const args = parseArgs(['--index', 'slav']);
  assert.equal(args.action, 'index');
  assert.equal(args.source, 'slav');
});

test('wallpaper-photos CLI: parseArgs --plan with --items and optional --source', () => {
  const args = parseArgs(['--plan', '--items', '/tmp/items.json', '--source', 'styleo']);
  assert.equal(args.action, 'plan');
  assert.equal(args.items, '/tmp/items.json');
  assert.equal(args.source, 'styleo');
});

test('wallpaper-photos CLI: parseArgs --run with --items and optional --source', () => {
  const args = parseArgs(['--run', '--items', '/tmp/items.json', '--source', 'epicentr']);
  assert.equal(args.action, 'run');
  assert.equal(args.source, 'epicentr');
});

test('wallpaper-photos CLI: parseArgs default cache dir is <repo>/data/photo-cache', () => {
  const args = parseArgs(['--index', 'slav']);
  assert.match(args.cacheDir, /data[\\/]photo-cache$/);
});

test('wallpaper-photos CLI: parseArgs --cache-dir override', () => {
  const args = parseArgs(['--index', 'slav', '--cache-dir', '/tmp/wc']);
  assert.equal(args.cacheDir, '/tmp/wc');
});

test('wallpaper-photos CLI: parseArgs rejects unknown/missing source for --index', () => {
  assert.throws(() => parseArgs(['--index', 'bogus']), /unknown source/i);
  assert.throws(() => parseArgs(['--index']), /--index requires a source/i);
});

test('wallpaper-photos CLI: parseArgs rejects no action and conflicting actions', () => {
  assert.throws(() => parseArgs([]), /usage/i);
  assert.throws(() => parseArgs(['--index', 'slav', '--plan']), /exactly one action/i);
  assert.throws(() => parseArgs(['--plan', '--run']), /exactly one action/i);
});

test('wallpaper-photos CLI: parseArgs rejects --plan without --items', () => {
  assert.throws(() => parseArgs(['--plan']), /--items/i);
});

test('wallpaper-photos CLI: parseArgs rejects unknown --source for --plan/--run', () => {
  assert.throws(
    () => parseArgs(['--plan', '--items', 'x.json', '--source', 'bogus']),
    /unknown source/i,
  );
});

// ---------------------------------------------------------------------------
// CLI: parseArgs --run (--items обязателен, --sources, --dry)
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: parseArgs --run requires --items', () => {
  assert.throws(() => parseArgs(['--run']), /--items/i);
});

test('wallpaper-photos CLI: parseArgs --run --sources dedupes and reorders to priority', () => {
  const args = parseArgs(['--run', '--items', '/tmp/i.json', '--sources', 'styleo,slav,styleo']);
  assert.equal(args.action, 'run');
  assert.deepEqual(args.sources, ['slav', 'styleo']);
  assert.equal(args.dry, false);
});

test('wallpaper-photos CLI: parseArgs --run --dry', () => {
  const args = parseArgs(['--run', '--items', '/tmp/i.json', '--dry']);
  assert.equal(args.dry, true);
});

test('wallpaper-photos CLI: parseArgs --run --source resolves a single-source list', () => {
  const args = parseArgs(['--run', '--items', '/tmp/i.json', '--source', 'epicentr']);
  assert.equal(args.source, 'epicentr');
  assert.deepEqual(args.sources, ['epicentr']);
});

test('wallpaper-photos CLI: parseArgs rejects --sources/--dry outside --run', () => {
  assert.throws(
    () => parseArgs(['--plan', '--items', 'x.json', '--dry']),
    /only valid with --run/i,
  );
  assert.throws(
    () => parseArgs(['--index', 'slav', '--sources', 'slav']),
    /only valid with --run/i,
  );
});

test('wallpaper-photos CLI: parseArgs rejects --source together with --sources', () => {
  assert.throws(
    () => parseArgs(['--run', '--items', 'x.json', '--source', 'slav', '--sources', 'slav']),
    /not both/i,
  );
});

test('wallpaper-photos CLI: parseArgs rejects unknown source in --sources', () => {
  assert.throws(
    () => parseArgs(['--run', '--items', 'x.json', '--sources', 'slav,bogus']),
    /unknown source/i,
  );
});

// ---------------------------------------------------------------------------
// CLI: parseArgs --specs (характеристики: slav-only, --items обязателен)
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: parseArgs --specs with --items, --dry and --url-map', () => {
  const args = parseArgs([
    '--specs',
    '--items',
    '/tmp/items.json',
    '--dry',
    '--url-map',
    '/tmp/map.json',
  ]);
  assert.equal(args.action, 'specs');
  assert.equal(args.items, '/tmp/items.json');
  assert.equal(args.dry, true);
  assert.deepEqual(args.urlMapFiles, ['/tmp/map.json']);
  assert.match(args.cacheDir, /data[\\/]photo-cache$/);
});

test('wallpaper-photos CLI: parseArgs --specs requires --items', () => {
  assert.throws(() => parseArgs(['--specs']), /--specs requires --items/i);
  assert.throws(() => parseArgs(['--specs', '--dry']), /--specs requires --items/i);
});

test('wallpaper-photos CLI: parseArgs --specs rejects --source/--sources (slav-only action)', () => {
  assert.throws(
    () => parseArgs(['--specs', '--items', 'x.json', '--source', 'slav']),
    /not applicable to --specs/i,
  );
  assert.throws(
    () => parseArgs(['--specs', '--items', 'x.json', '--sources', 'slav,epicentr']),
    /not applicable to --specs/i,
  );
});

test('wallpaper-photos CLI: parseArgs rejects conflicting --specs with other actions', () => {
  assert.throws(() => parseArgs(['--specs', '--run', '--items', 'x.json']), /exactly one action/i);
});

// ---------------------------------------------------------------------------
// CLI: --run — runtime-тесты на стабах (fake fetch + fake supabase-клиент)
// ---------------------------------------------------------------------------

interface FakeImageRow {
  product_id: string;
  image_url: string;
  is_main: boolean;
  sort_order: number;
}

interface FakeDb {
  client: SupabaseClient;
  inserted: FakeImageRow[];
  /** products.specifications UPDATE (--specs): {id,Specifications payload}. */
  updates: { id: string; specifications: unknown }[];
  uploads: { path: string; contentType: string; byteLength: number }[];
  inChunkSizes: number[];
  windows: string[];
  pairs: { product_id: string; image_url: string }[];
  key: (productId: string, imageUrl: string) => string;
}

/** In-memory supabase-клиент: paged-чтения с реальным range-поведением,
 * INSERT с симуляцией 23505, Storage upload, products UPDATE (--specs). */
function makeFakeDb(opts: {
  products?: { id: string; sku: string }[];
  pairs?: { product_id: string; image_url: string }[];
  /** Эти пары INSERT возвращает как 23505. */
  duplicatePairs?: string[];
  /** path -> сообщение об ошибке upload. */
  uploadErrors?: Record<string, string>;
  /** product id -> сообщение об ошибке products UPDATE (--specs). */
  updateErrors?: Record<string, string>;
}): FakeDb {
  const products = (opts.products ?? []).map((p) => ({ ...p }));
  const pairs = (opts.pairs ?? []).map((p) => ({ ...p }));
  const inserted: FakeImageRow[] = [];
  const updates: FakeDb['updates'] = [];
  const uploads: FakeDb['uploads'] = [];
  const inChunkSizes: number[] = [];
  const windows: string[] = [];
  const key = (productId: string, imageUrl: string): string => `${productId}\u0000${imageUrl}`;

  const client = {
    from(table: string) {
      if (table === 'products') {
        const state = { from: 0, to: -1 };
        const b = {
          select: () => b,
          is: () => b,
          like: () => b,
          order: (column: string) => {
            windows.push(`products order=${column}`);
            return b;
          },
          range: (from: number, to: number) => {
            state.from = from;
            state.to = to;
            windows.push(`products range=${from}-${to}`);
            return b;
          },
          returns: () => b,
          then: (resolve: (value: unknown) => void) => {
            resolve({ data: products.slice(state.from, state.to + 1), error: null });
          },
          update: (values: Record<string, unknown>) => ({
            eq: (_column: string, value: string) => ({
              then: (resolve: (value: unknown) => void) => {
                const message = opts.updateErrors?.[value];
                if (message !== undefined) {
                  resolve({ data: null, error: { message } });
                  return;
                }
                updates.push({ id: value, specifications: values['specifications'] });
                resolve({ data: null, error: null });
              },
            }),
          }),
        };
        return b;
      }
      if (table === 'product_images') {
        const state = { inGroup: null as string[] | null, from: 0, to: -1 };
        const b = {
          select: () => b,
          in: (_column: string, group: string[]) => {
            state.inGroup = group;
            inChunkSizes.push(group.length);
            return b;
          },
          order: (column: string) => {
            windows.push(`product_images order=${column}`);
            return b;
          },
          range: (from: number, to: number) => {
            state.from = from;
            state.to = to;
            windows.push(`product_images range=${from}-${to}`);
            return b;
          },
          returns: () => b,
          then: (resolve: (value: unknown) => void) => {
            const group = state.inGroup;
            const scoped =
              group === null ? pairs : pairs.filter((r) => group.includes(r.product_id));
            resolve({ data: scoped.slice(state.from, state.to + 1), error: null });
          },
          insert: (row: FakeImageRow) => ({
            then: (resolve: (value: unknown) => void) => {
              if (opts.duplicatePairs?.includes(key(row.product_id, row.image_url)) === true) {
                resolve({
                  data: null,
                  error: {
                    code: '23505',
                    message:
                      'duplicate key value violates unique constraint "idx_product_images_product_url"',
                  },
                });
                return;
              }
              pairs.push({ product_id: row.product_id, image_url: row.image_url });
              inserted.push({ ...row });
              resolve({ data: null, error: null });
            },
          }),
        };
        return b;
      }
      throw new Error(`fake db: unexpected table ${table}`);
    },
    storage: {
      from() {
        return {
          upload: async (path: string, bytes: Uint8Array, config: { contentType: string }) => {
            const message = opts.uploadErrors?.[path];
            if (message !== undefined) return { data: null, error: { message } };
            uploads.push({ path, contentType: config.contentType, byteLength: bytes.byteLength });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return {
    client: client as unknown as SupabaseClient,
    inserted,
    updates,
    uploads,
    inChunkSizes,
    windows,
    pairs,
    key,
  };
}

async function runForTest(opts: {
  items: PhotoItem[];
  sources: PhotoSource[];
  caches: Record<string, string[]>;
  fetchText?: (url: string) => Promise<string>;
  fetchImage?: (url: string) => Promise<Uint8Array>;
  products?: { id: string; sku: string }[];
  pairs?: { product_id: string; image_url: string }[];
  duplicatePairs?: string[];
  uploadErrors?: Record<string, string>;
  dry?: boolean;
}): Promise<{ db: FakeDb; totals: RunTotals; cacheDir: string }> {
  const cacheDir = makeTmpDir();
  for (const [source, urls] of Object.entries(opts.caches)) writeCache(cacheDir, source, urls);
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(itemsPath, JSON.stringify(opts.items));
  const db = makeFakeDb(opts);
  const totals = await run(
    { itemsPath, sources: opts.sources, cacheDir, dry: opts.dry === true },
    {
      client: db.client,
      fetchText:
        opts.fetchText ??
        (async () => {
          throw new Error('unexpected fetchText call');
        }),
      fetchImage:
        opts.fetchImage ??
        (async () => {
          throw new Error('unexpected fetchImage call');
        }),
      throttleMs: 0,
      log: () => {},
    },
  );
  return { db, totals, cacheDir };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03,
]);
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

test('wallpaper-photos CLI: run() slav — пишет ТОЛЬКО главное фото (1 фото = 1 карточка)', async () => {
  const page =
    '<html><body>' +
    '<img src="https://oboi-slav-oboi.com/assets/products/2746/main.jpg">' +
    "<img src='/assets/products/2746/tex-1.jpg'>" +
    '<img src="/assets/products/2746/tex-2.jpg">' +
    '</body></html>';
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    sources: ['slav'],
    caches: { slav: [SLAV_URL] },
    fetchText: async (url) => {
      assert.equal(url, SLAV_URL);
      return page;
    },
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  // Решение владельца 2026-09-10: текстуры (другие колеровки серии) в
  // карточку НЕ пишутся — ровно одна строка main.
  assert.equal(db.inserted.length, 1);
  assert.deepEqual(db.inserted[0], {
    product_id: 'p-100',
    image_url: 'https://oboi-slav-oboi.com/assets/products/2746/main.jpg',
    is_main: true,
    sort_order: 0,
  });
  assert.equal(db.uploads.length, 0);
  assert.equal(totals.bySource.slav?.matched, 1);
  assert.equal(totals.bySource.slav?.hotlinked, 1);
  assert.equal(totals.insertedRows, 1);
  assert.deepEqual(totals.noPhotoCodes, []);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() epicentr — скачивает, upload в Storage, ОТНОСИТЕЛЬНЫЙ путь в БД', async () => {
  const imageUrl = 'https://epicentrk.ua/upload/oboi-bravo-86000br90-1-06x10-05-m.jpg';
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '200', name: 'Браво темні', article: '86000BR90' }],
    sources: ['epicentr'],
    caches: { epicentr: [imageUrl] },
    fetchImage: async (url) => {
      assert.equal(url, imageUrl);
      return JPEG_BYTES;
    },
    products: [{ id: 'p-200', sku: 'wc-86000br90' }],
  });
  assert.equal(db.uploads.length, 1);
  assert.deepEqual(db.uploads[0], {
    path: 'wc-86000br90/oboi-bravo-86000br90-1-06x10-05-m.jpg',
    contentType: 'image/jpeg',
    byteLength: JPEG_BYTES.byteLength,
  });
  assert.deepEqual(db.inserted, [
    {
      product_id: 'p-200',
      image_url: 'wc-86000br90/oboi-bravo-86000br90-1-06x10-05-m.jpg',
      is_main: true,
      sort_order: 0,
    },
  ]);
  assert.equal(totals.bySource.epicentr?.downloaded, 1);
  assert.equal(totals.bySource.epicentr?.hotlinked, 0);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() 23505 — no-op, не фатал, позиция закрыта', async () => {
  const dupUrl = 'https://oboi-slav-oboi.com/assets/products/1/main.jpg';
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '100', name: 'шпалери', article: '6647-04' }],
    sources: ['slav'],
    caches: { slav: [SLAV_URL] },
    fetchText: async () => `<img src="${dupUrl}">`,
    products: [{ id: 'p-1', sku: 'wc-6647-04' }],
    duplicatePairs: [`p-1\u0000${dupUrl}`],
  });
  assert.equal(db.inserted.length, 0);
  assert.equal(totals.bySource.slav?.noop23505, 1);
  assert.deepEqual(totals.noPhotoCodes, []);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() идемпотентный повтор — 0 вставок, upload не повторяется', async () => {
  const cacheDir = makeTmpDir();
  writeCache(cacheDir, 'epicentr', ['https://epicentrk.ua/upload/oboi-bravo-86000br90.jpg']);
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(
    itemsPath,
    JSON.stringify([{ code: '200', name: 'Браво темні', article: '86000BR90' }]),
  );
  const db = makeFakeDb({ products: [{ id: 'p-200', sku: 'wc-86000br90' }] });
  const deps = {
    client: db.client,
    fetchImage: async () => JPEG_BYTES,
    throttleMs: 0,
    log: () => {},
  };
  const first = await run({ itemsPath, sources: ['epicentr'], cacheDir, dry: false }, deps);
  assert.equal(first.insertedRows, 1);
  const second = await run({ itemsPath, sources: ['epicentr'], cacheDir, dry: false }, deps);
  assert.equal(second.insertedRows, 0);
  assert.equal(second.alreadyHadPhotos, 1);
  assert.equal(second.matchedProducts, 0);
  assert.equal(db.inserted.length, 1);
  assert.equal(db.uploads.length, 1);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() первый источник закрывает позицию — epicentr не трогается', async () => {
  let epicentrTried = false;
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    sources: ['slav', 'epicentr'],
    caches: { slav: [SLAV_URL], epicentr: ['https://epicentrk.ua/upload/oboi-6647-04.jpg'] },
    fetchText: async () =>
      '<img src="https://oboi-slav-oboi.com/assets/products/2746/main.jpg">',
    fetchImage: async () => {
      epicentrTried = true;
      return JPEG_BYTES;
    },
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  assert.equal(epicentrTried, false);
  assert.equal(db.inserted.length, 1);
  assert.equal(totals.bySource.slav?.matched, 1);
  assert.equal(totals.bySource.epicentr?.matched, 0);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() без кэша индекса — честная ошибка «сначала --index»', async () => {
  const cacheDir = makeTmpDir();
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(itemsPath, JSON.stringify([{ code: '1', name: 'x', article: null }]));
  await assert.rejects(
    run(
      { itemsPath, sources: ['epicentr'], cacheDir, dry: true },
      { client: makeFakeDb({}).client, log: () => {} },
    ),
    /--index epicentr/,
  );
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() --dry — читает и матчит, но 0 записей в БД/Storage', async () => {
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '200', name: 'Браво темні', article: '86000BR90' }],
    sources: ['epicentr'],
    caches: { epicentr: ['https://epicentrk.ua/upload/oboi-bravo-86000br90.jpg'] },
    fetchImage: async () => JPEG_BYTES,
    products: [{ id: 'p-200', sku: 'wc-86000br90' }],
    dry: true,
  });
  assert.equal(db.inserted.length, 0);
  assert.equal(db.uploads.length, 0);
  assert.equal(totals.insertedRows, 1); // would-write счётчик
  assert.equal(totals.bySource.epicentr?.downloaded, 1);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() сбой скачивания не фатален — позиция достаётся следующему источнику', async () => {
  const styleoUrl = 'https://styleo.com.ua/p/oboi-bravo-86000br90';
  const epicentrUrl = 'https://epicentrk.ua/upload/oboi-bravo-86000br90.jpg';
  const { totals, cacheDir } = await runForTest({
    items: [{ code: '200', name: 'Браво темні', article: '86000BR90' }],
    sources: ['epicentr', 'styleo'],
    caches: { epicentr: [epicentrUrl], styleo: [styleoUrl] },
    fetchImage: async (url) => {
      if (url === epicentrUrl) throw new HttpFetchError(404, 'HTTP 404');
      return PNG_BYTES;
    },
    products: [{ id: 'p-200', sku: 'wc-86000br90' }],
  });
  assert.equal(totals.bySource.epicentr?.failed, 1);
  assert.equal(totals.bySource.styleo?.downloaded, 1);
  assert.deepEqual(totals.downloadFailedCodes, []); // спасено styleo
  assert.deepEqual(totals.noPhotoCodes, []);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() сбой на всех источниках — «сбой скачивания» + «без фото»', async () => {
  const { totals, cacheDir } = await runForTest({
    items: [{ code: '200', name: 'Браво темні', article: '86000BR90' }],
    sources: ['epicentr', 'styleo'],
    caches: {
      epicentr: ['https://epicentrk.ua/upload/oboi-bravo-86000br90.jpg'],
      styleo: ['https://styleo.com.ua/p/oboi-bravo-86000br90'],
    },
    fetchImage: async () => {
      throw new HttpFetchError(500, 'HTTP 500');
    },
    products: [{ id: 'p-200', sku: 'wc-86000br90' }],
  });
  assert.equal(totals.bySource.epicentr?.failed, 1);
  assert.equal(totals.bySource.styleo?.failed, 1);
  assert.deepEqual(totals.downloadFailedCodes, ['200']);
  assert.deepEqual(totals.noPhotoCodes, ['200']);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() >5 МБ и не-image magic bytes — сбой без записи', async () => {
  const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  oversized[2] = 0xff;
  const garbage = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const { db, totals, cacheDir } = await runForTest({
    items: [
      { code: '300', name: 'шпалери 5243-02', article: '5243-02' },
      { code: '400', name: 'шпалери 30202', article: '30202' },
    ],
    sources: ['epicentr'],
    caches: {
      epicentr: [
        'https://epicentrk.ua/upload/oboi-5243-02.jpg',
        'https://epicentrk.ua/upload/oboi-30202.jpg',
      ],
    },
    fetchImage: async (url) => (url.includes('5243-02') ? oversized : garbage),
    products: [
      { id: 'p-300', sku: 'wc-5243-02' },
      { id: 'p-400', sku: 'wc-30202' },
    ],
  });
  assert.equal(db.inserted.length, 0);
  assert.equal(db.uploads.length, 0);
  assert.equal(totals.bySource.epicentr?.failed, 2);
  assert.deepEqual(totals.downloadFailedCodes, ['300', '400']);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() пагинация — окна ≤1000 c .order(id), .in чанки ≤200, сквозной матч', async () => {
  const products = Array.from({ length: 2500 }, (_, i) => ({
    id: `p-${i}`,
    sku: `wc-x${1000 + i}`,
  }));
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '3499', name: 'шпалери 3499', article: null }], // sku = wc-x3499 (последний товар)
    sources: ['slav'],
    caches: { slav: ['https://oboi-slav-oboi.com/ua/v1-3499/'] },
    fetchText: async () => '<img src="/assets/products/3499/main.jpg">',
    products,
  });
  assert.deepEqual(db.inserted, [
    {
      product_id: 'p-2499',
      image_url: 'https://oboi-slav-oboi.com/assets/products/3499/main.jpg',
      is_main: true,
      sort_order: 0,
    },
  ]);
  const productWindows = db.windows
    .filter((w) => w.startsWith('products range='))
    .map((w) => w.replace('products range=', ''));
  assert.deepEqual(productWindows, ['0-999', '1000-1999', '2000-2999']);
  assert.ok(db.windows.includes('products order=id'));
  assert.ok(db.windows.includes('product_images order=product_id'));
  assert.ok(db.inChunkSizes.length > 1);
  for (const size of db.inChunkSizes) assert.ok(size <= 200);
  assert.equal(
    db.inChunkSizes.reduce((sum, size) => sum + size, 0),
    2500,
  );
  assert.deepEqual(totals.noPhotoCodes, []);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: run() позиция без wc-* товара — пропущена (без товара)', async () => {
  let fetched = false;
  const { db, totals, cacheDir } = await runForTest({
    items: [{ code: '999', name: 'шпалери', article: null }], // sku wc-x999 — нет в products
    sources: ['slav'],
    caches: { slav: [SLAV_URL] },
    fetchText: async () => {
      fetched = true;
      return '<img src="/assets/products/1/main.jpg">';
    },
    products: [{ id: 'p-1', sku: 'wc-x1' }],
  });
  assert.equal(fetched, false);
  assert.equal(db.inserted.length, 0);
  assert.equal(totals.noProduct, 1);
  assert.deepEqual(totals.noPhotoCodes, []);
  cleanup(cacheDir);
});

// ---------------------------------------------------------------------------
// CLI: --specs — runtime-тесты на стабах (fake fetch + fake supabase-клиент)
// ---------------------------------------------------------------------------

/** Страница slav с характеристиками: реальный фрагмент (пары + помещения). */
const SPECS_PAGE = `<html><body>${SLAV_SPECS_FRAGMENT}${SLAV_ROOMS_FRAGMENT}</body></html>`;
const SPECS_PAYLOAD = [
  { name: 'Довжина', value: '10.05 м' },
  { name: 'Ширина', value: '0.53 м' },
  { name: 'Основа', value: 'Паперова' },
  { name: 'Приміщення', value: 'Вітальня, Спальня' },
];

async function runSpecsForTest(opts: {
  items: PhotoItem[];
  slavUrls?: string[];
  fetchText?: (url: string) => Promise<string>;
  products?: { id: string; sku: string }[];
  urlMap?: Record<string, string>;
  dry?: boolean;
  throttleMs?: number;
  updateErrors?: Record<string, string>;
}): Promise<{ db: FakeDb; totals: SpecsRunTotals; cacheDir: string }> {
  const cacheDir = makeTmpDir();
  writeCache(cacheDir, 'slav', opts.slavUrls ?? []);
  let urlMapFiles: string[] | undefined;
  if (opts.urlMap !== undefined) {
    const mapPath = path.join(cacheDir, 'url-map.json');
    writeFileSync(mapPath, JSON.stringify(opts.urlMap));
    urlMapFiles = [mapPath];
  }
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(itemsPath, JSON.stringify(opts.items));
  const db = makeFakeDb({ products: opts.products, updateErrors: opts.updateErrors });
  const totals = await runSpecs(
    { itemsPath, cacheDir, dry: opts.dry === true, urlMapFiles },
    {
      client: db.client,
      fetchText:
        opts.fetchText ??
        (async () => {
          throw new Error('unexpected fetchText call');
        }),
      throttleMs: opts.throttleMs ?? 0,
      log: () => {},
    },
  );
  return { db, totals, cacheDir };
}

test('wallpaper-photos CLI: --specs — UPDATE products.specifications jsonb-массивом пар', async () => {
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    slavUrls: [SLAV_URL],
    fetchText: async (url) => {
      assert.equal(url, SLAV_URL);
      return SPECS_PAGE;
    },
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  assert.equal(db.updates.length, 1);
  assert.deepEqual(db.updates[0], { id: 'p-100', specifications: SPECS_PAYLOAD });
  assert.equal(totals.items, 1);
  assert.equal(totals.productsWc, 1);
  assert.equal(totals.matched, 1);
  assert.equal(totals.updated, 1);
  assert.equal(totals.emptySpecs, 0);
  assert.equal(totals.failed, 0);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs --dry — скачивает и парсит, но 0 UPDATE', async () => {
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    slavUrls: [SLAV_URL],
    fetchText: async () => SPECS_PAGE,
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
    dry: true,
  });
  assert.equal(db.updates.length, 0); // записей нет
  assert.equal(totals.updated, 1); // would-write счётчик
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs — страница без характеристик: товар НЕ трогается', async () => {
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    slavUrls: [SLAV_URL],
    fetchText: async () => '<html><body><p>страница без таблицы характеристик</p></body></html>',
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  assert.equal(db.updates.length, 0);
  assert.equal(totals.emptySpecs, 1);
  assert.equal(totals.updated, 0);
  assert.equal(totals.matched, 1);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs — throttle 200мс-контракт между скачиваниями страниц', async () => {
  const stamps: number[] = [];
  const secondUrl = 'https://oboi-slav-oboi.com/ua/v1-5310-02/';
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [
      { code: '100', name: 'шпалери 6647-04', article: '6647-04' },
      { code: '300', name: 'шпалери 5310-02', article: '5310-02' },
    ],
    slavUrls: [SLAV_URL, secondUrl],
    fetchText: async () => {
      stamps.push(Date.now());
      return SPECS_PAGE;
    },
    products: [
      { id: 'p-100', sku: 'wc-6647-04' },
      { id: 'p-300', sku: 'wc-5310-02' },
    ],
    throttleMs: 100,
  });
  assert.equal(stamps.length, 2);
  const [firstStamp, secondStamp] = stamps;
  assert.ok(firstStamp !== undefined && secondStamp !== undefined);
  assert.ok(secondStamp - firstStamp >= 50, `gap ${secondStamp - firstStamp}ms below throttle`);
  assert.equal(db.updates.length, 2);
  assert.equal(totals.updated, 2);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs --url-map — slav-переопределение работает, не-slav записи игнорируются', async () => {
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    slavUrls: [], // пустой индекс: без url-map матча не было бы
    urlMap: {
      '100': SLAV_URL,
      '999': 'https://epicentrk.ua/upload/not-slav.jpg', // чужой источник — мимо
    },
    fetchText: async (url) => {
      assert.equal(url, SLAV_URL);
      return SPECS_PAGE;
    },
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  assert.equal(db.updates.length, 1);
  assert.deepEqual(db.updates[0]?.specifications, SPECS_PAYLOAD);
  assert.equal(totals.matched, 1);
  assert.equal(totals.noMatch, 0);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs — сбой скачивания не фатален, товар не тронут', async () => {
  const { db, totals, cacheDir } = await runSpecsForTest({
    items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
    slavUrls: [SLAV_URL],
    fetchText: async () => {
      throw new HttpFetchError(500, 'HTTP 500');
    },
    products: [{ id: 'p-100', sku: 'wc-6647-04' }],
  });
  assert.equal(db.updates.length, 0);
  assert.equal(totals.failed, 1);
  assert.equal(totals.updated, 0);
  cleanup(cacheDir);
});

test('wallpaper-photos CLI: --specs — ошибка UPDATE останавливает run (fail-fast, re-run = recovery)', async () => {
  await assert.rejects(
    runSpecsForTest({
      items: [{ code: '100', name: 'шпалери 6647-04', article: '6647-04' }],
      slavUrls: [SLAV_URL],
      fetchText: async () => SPECS_PAGE,
      products: [{ id: 'p-100', sku: 'wc-6647-04' }],
      updateErrors: { 'p-100': 'violates foreign key constraint' },
    }),
    /products.specifications update \(id=p-100/,
  );
});

test('wallpaper-photos CLI: --specs без кэша slav-индекса — честная ошибка «сначала --index»', async () => {
  const cacheDir = makeTmpDir();
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(itemsPath, JSON.stringify([{ code: '1', name: 'x', article: null }]));
  await assert.rejects(
    runSpecs(
      { itemsPath, cacheDir, dry: true },
      { client: makeFakeDb({}).client, log: () => {} },
    ),
    /--index slav/,
  );
  cleanup(cacheDir);
});

// ---------------------------------------------------------------------------
// CLI: --index с инжектированным fetch (без сети), кэш во временную папку
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'wallpaper-photos-test-'));
}

test('wallpaper-photos CLI: --index slav fetches sitemap, dedupes and writes cache JSON', async () => {
  const cacheDir = makeTmpDir();
  const xml = `<urlset>
    <url><loc>${SLAV_URL}</loc></url>
    <url><loc>${SLAV_URL}</loc></url>
    <url><loc>https://oboi-slav-oboi.com/ua/v278-1234-56/</loc></url>
  </urlset>`;
  const calls: string[] = [];
  const exit = await runPhotosCli(['--index', 'slav', '--cache-dir', cacheDir], {
    fetchText: async (url) => {
      calls.push(url);
      return xml;
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(calls, ['https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml']);

  const cachePath = path.join(cacheDir, 'slav.json');
  assert.ok(existsSync(cachePath));
  const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
    source: string;
    indexedAt: string;
    sitemapUrls: string[];
    urlCount: number;
    urls: string[];
  };
  assert.equal(cache.source, 'slav');
  assert.ok(!Number.isNaN(Date.parse(cache.indexedAt)));
  assert.deepEqual(cache.sitemapUrls, ['https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml']);
  assert.equal(cache.urlCount, 2);
  assert.deepEqual(cache.urls, [
    SLAV_URL,
    'https://oboi-slav-oboi.com/ua/v278-1234-56/',
  ]);
  rmSync(cacheDir, { recursive: true, force: true });
});

test('wallpaper-photos CLI: --index epicentr falls back to _000 sitemap on 404', async () => {
  const cacheDir = makeTmpDir();
  const calls: string[] = [];
  const exit = await runPhotosCli(['--index', 'epicentr', '--cache-dir', cacheDir], {
    fetchText: async (url) => {
      calls.push(url);
      if (url.endsWith('products_main_ua.xml')) {
        throw new HttpFetchError(404, 'HTTP 404');
      }
      return `<urlset><url><loc>${EPICENTR_URL}</loc></url></urlset>`;
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(calls, [
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua.xml',
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua_000.xml',
  ]);
  const cache = JSON.parse(readFileSync(path.join(cacheDir, 'epicentr.json'), 'utf8'));
  assert.deepEqual(cache.urls, [EPICENTR_URL]);
  assert.deepEqual(cache.sitemapUrls, [
    'https://epicentrk.ua/upload/sitemap/new/products_ep/products_main_ua_000.xml',
  ]);
  rmSync(cacheDir, { recursive: true, force: true });
});

test('wallpaper-photos CLI: --index epicentr fails when both sitemaps are 404', async () => {
  await assert.rejects(
    runPhotosCli(['--index', 'epicentr', '--cache-dir', makeTmpDir()], {
      fetchText: async () => {
        throw new HttpFetchError(404, 'HTTP 404');
      },
    }),
    /404/,
  );
});

test('wallpaper-photos CLI: --index styleo concatenates -01 and -02 sitemaps (-02 failure tolerated)', async () => {
  const cacheDir = makeTmpDir();
  const calls: string[] = [];
  const exit = await runPhotosCli(['--index', 'styleo', '--cache-dir', cacheDir], {
    fetchText: async (url) => {
      calls.push(url);
      if (url.endsWith('catalog-sitemap-01.xml')) {
        return '<urlset><url><loc>https://styleo.com.ua/p/1</loc></url></urlset>';
      }
      throw new HttpFetchError(404, 'HTTP 404');
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(calls, [
    'https://styleo.com.ua/catalog-sitemap-01.xml',
    'https://styleo.com.ua/catalog-sitemap-02.xml',
  ]);
  const cache = JSON.parse(readFileSync(path.join(cacheDir, 'styleo.json'), 'utf8'));
  assert.deepEqual(cache.urls, ['https://styleo.com.ua/p/1']);
  rmSync(cacheDir, { recursive: true, force: true });
});

test('wallpaper-photos CLI: --index follows one level of sitemap-index nesting', async () => {
  const cacheDir = makeTmpDir();
  const calls: string[] = [];
  const exit = await runPhotosCli(['--index', 'slav', '--cache-dir', cacheDir], {
    fetchText: async (url) => {
      calls.push(url);
      if (url === 'https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml') {
        return `<sitemapindex>
          <loc>https://cdn.oboi-slav-oboi.com/sm-1.xml</loc>
          <loc>https://oboi-slav-oboi.com/ua/page/</loc>
          <loc>https://cdn.oboi-slav-oboi.com/sm-2.xml</loc>
        </sitemapindex>`;
      }
      if (url === 'https://cdn.oboi-slav-oboi.com/sm-1.xml') {
        return '<urlset><url><loc>https://oboi-slav-oboi.com/ua/v1/</loc></url></urlset>';
      }
      return '<urlset><url><loc>https://oboi-slav-oboi.com/ua/v2/</loc></url></urlset>';
    },
  });
  assert.equal(exit, 0);
  assert.deepEqual(calls, [
    'https://oboi-slav-oboi.com/sitemaps/sitemap-product-ua.xml',
    'https://cdn.oboi-slav-oboi.com/sm-1.xml',
    'https://cdn.oboi-slav-oboi.com/sm-2.xml',
  ]);
  const cache = JSON.parse(readFileSync(path.join(cacheDir, 'slav.json'), 'utf8'));
  assert.deepEqual(cache.urls, [
    'https://oboi-slav-oboi.com/ua/page/',
    'https://oboi-slav-oboi.com/ua/v1/',
    'https://oboi-slav-oboi.com/ua/v2/',
  ]);
  rmSync(cacheDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI: --plan с кэшем из временной папки и items-файлом
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: --plan reads caches + items file and prints coverage', async () => {
  const cacheDir = makeTmpDir();
  writeCache(cacheDir, 'slav', [SLAV_URL]);
  writeCache(cacheDir, 'epicentr', [EPICENTR_URL]);

  const itemsPath = path.join(cacheDir, 'items.json');
  const items: PhotoItem[] = [
    { code: '100', name: 'шпалери 6647-04', article: '6647-04' },
    { code: '200', name: 'Браво темні', article: '86000BR90' },
    { code: '300', name: 'шпалери сірі', article: null },
  ];
  writeFileSync(itemsPath, JSON.stringify(items));

  const logs: string[] = [];
  const exit = await runPhotosCli(
    ['--plan', '--items', itemsPath, '--cache-dir', cacheDir],
    { log: (line) => logs.push(String(line)) },
  );
  assert.equal(exit, 0);
  const out = logs.join('\n');
  assert.match(out, /covered=1\/3/); // slav
  assert.match(out, /covered=1\/3/); // epicentr (та же доля, другой item)
  assert.match(out, /uncovered=1/);
  assert.match(out, /\b300\b/); // код непокрытой позиции в отчёте
  rmSync(cacheDir, { recursive: true, force: true });
});

test('wallpaper-photos CLI: --plan warns about missing cache and continues', async () => {
  const cacheDir = makeTmpDir();
  const itemsPath = path.join(cacheDir, 'items.json');
  writeFileSync(itemsPath, JSON.stringify(ITEMS));

  const logs: string[] = [];
  const exit = await runPhotosCli(
    ['--plan', '--items', itemsPath, '--cache-dir', cacheDir],
    { log: (line) => logs.push(String(line)) },
  );
  assert.equal(exit, 0);
  const out = logs.join('\n');
  assert.match(out, /no cache .*--index/i);
  assert.match(out, /covered=0\/3/);
  rmSync(cacheDir, { recursive: true, force: true });
});

test('wallpaper-photos CLI: --plan rejects invalid items JSON shapes', async () => {
  const cacheDir = makeTmpDir();
  const bad = path.join(cacheDir, 'bad.json');
  writeFileSync(bad, JSON.stringify({ not: 'an array' }));
  await assert.rejects(
    runPhotosCli(['--plan', '--items', bad, '--cache-dir', cacheDir], {
      log: () => {},
    }),
    /array/i,
  );
  writeFileSync(bad, JSON.stringify([{ code: '1' }]));
  await assert.rejects(
    runPhotosCli(['--plan', '--items', bad, '--cache-dir', cacheDir], {
      log: () => {},
    }),
    /name/i,
  );
  rmSync(cacheDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CLI: статические инварианты (без сети/БД/Storage)
// ---------------------------------------------------------------------------

function readPhotosScriptSource(): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'wallpaper-photos.ts'),
    'utf8',
  );
}

test('wallpaper-photos CLI: static invariants — timeout 30s, UA header, throttle 200ms, cache dir', () => {
  const src = readPhotosScriptSource();
  assert.match(src, /FETCH_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(src, /AbortSignal\.timeout\(\s*FETCH_TIMEOUT_MS\s*\)/);
  assert.match(src, /['"]user-agent['"]/);
  assert.match(src, /THROTTLE_MS\s*=\s*200/);
  assert.match(src, /data['"],\s*['"]photo-cache/);
});

test('wallpaper-photos CLI: static invariants — --run: service-role, diff-aware, лимиты пагинации', () => {
  const src = readPhotosScriptSource();
  // окна чтения ≤1000 с tiebreaker, .in чанки ≤200 (проектные инварианты)
  assert.match(src, /PAGE_SIZE\s*=\s*1000/);
  assert.match(src, /PAIR_CHUNK_SIZE\s*=\s*200/);
  assert.match(src, /\.order\('product_id'\)/);
  assert.match(src, /\.order\('id'\)/);
  // service-role клиент собирается ЛЕНИВО внутри --run (паттерн wallpaper-import.ts)
  assert.match(src, /persistSession:\s*false/);
  assert.match(src, /await import\('@supabase\/supabase-js'\)/);
  assert.match(src, /\.env\.local/);
  // Storage: bucket, санитизация имени, magic bytes + лимит 5 МБ, без upsert
  assert.match(src, /STORAGE_BUCKET\s*=\s*'product_images'/);
  assert.match(src, /sanitizeUploadFileName/);
  assert.match(src, /MAX_IMAGE_BYTES\s*=\s*5 \* 1024 \* 1024/);
  assert.match(src, /upsert:\s*false/);
  // --run без --items невозможен (fail-closed, как --plan)
  assert.match(src, /--run requires --items/);
});

test('wallpaper-photos CLI: static invariants — --specs: slav-only, --items обязателен, парсер подключён', () => {
  const src = readPhotosScriptSource();
  // fail-closed CLI-контракт
  assert.match(src, /--specs requires --items/);
  assert.match(src, /not applicable to --specs/);
  // характеристики пишет ТОЛЬКО pure-парсер из photo-sources (никакого HTML-парсинга в CLI)
  assert.match(src, /parseSlavCharacteristics/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  // 1 фото = 1 карточка: решение владельца зафиксировано в slav-ветке run()
  assert.match(src, /1 фото = 1 карточка/);
  assert.match(src, /ПЕРЕЗАПИСЫВАЕТСЯ slav-версией/);
});

// ---------------------------------------------------------------------------

function writeCache(cacheDir: string, source: string, urls: string[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, `${source}.json`),
    JSON.stringify({ source, indexedAt: new Date().toISOString(), sitemapUrls: [], urlCount: urls.length, urls }),
  );
}
