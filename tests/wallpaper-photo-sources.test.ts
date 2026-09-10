/**
 * Task 8 (wallpapers import): фото-пайплайн — pure-матчеры источников
 * (app/lib/wallpapers/photo-sources.ts) + CLI-контракт
 * (scripts/wallpaper-photos.ts: --index / --plan / --run-stub).
 *
 * Фикстуры-URL — реальные примеры из research плана
 * (docs/superpowers/plans/2026-09-10-wallpapers-import.md, Task 8):
 * v277-6647-04 (slav), bravo-86000br90 (epicentr), хеш-суффиксы -01f4bd.
 *
 * Сетевых вызовов НЕТ: fetch инжектируется (CLI deps), кэш — во временных
 * папках os.tmpdir(). БД/Storage не трогаются.
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
  matchSourceUrl,
  matchSourceByUrl,
  normalizeArticleToken,
  extractSitemapUrls,
  MAX_TEXTURES,
  pickMainAndTextures,
  planPhotoCoverage,
  unionCoveredCodes,
  type PhotoItem,
} from '../app/lib/wallpapers/photo-sources.ts';
import {
  HttpFetchError,
  articleTokensForItem,
  parseArgs,
  run,
  runPhotosCli,
} from '../scripts/wallpaper-photos.ts';

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

test('wallpaper-photos CLI: parseArgs --run with optional --source', () => {
  const args = parseArgs(['--run', '--source', 'epicentr']);
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
// CLI: --run is an explicit stub until the orchestrator GO
// ---------------------------------------------------------------------------

test('wallpaper-photos CLI: run() rejects with NOT_IMPLEMENTED_WAITING_ORCHESTRATOR', async () => {
  await assert.rejects(run(), /NOT_IMPLEMENTED_WAITING_ORCHESTRATOR/);
  await assert.rejects(
    runPhotosCli(['--run'], { cacheDir: mkdtempSync(path.join(tmpdir(), 'wc-run-')) }),
    /NOT_IMPLEMENTED_WAITING_ORCHESTRATOR/,
  );
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

test('wallpaper-photos CLI: static invariants — timeout 30s, UA header, throttle 200ms, no DB/Storage', () => {
  const scriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'wallpaper-photos.ts',
  );
  const src = readFileSync(scriptPath, 'utf8');
  assert.match(src, /FETCH_TIMEOUT_MS\s*=\s*30_000/);
  assert.match(src, /AbortSignal\.timeout\(\s*FETCH_TIMEOUT_MS\s*\)/);
  assert.match(src, /['"]user-agent['"]/);
  assert.match(src, /THROTTLE_MS\s*=\s*200/);
  assert.match(src, /throw new Error\('NOT_IMPLEMENTED_WAITING_ORCHESTRATOR'\)/);
  // задача 8 НЕ пишет в БД/Storage: никаких supabase-клиентов
  assert.doesNotMatch(src, /@supabase/);
  assert.match(src, /data['"],\s*['"]photo-cache/);
});

// ---------------------------------------------------------------------------

function writeCache(cacheDir: string, source: string, urls: string[]): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, `${source}.json`),
    JSON.stringify({ source, indexedAt: new Date().toISOString(), sitemapUrls: [], urlCount: urls.length, urls }),
  );
}
