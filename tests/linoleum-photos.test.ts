/**
 * Лінолеум, сид-фото дизайнів: scripts/linoleum-photos.ts
 * (зеркало контракт-тестів tests/wallpaper-photo-sources.test.ts +
 * tests/linoleum-import-cli.test.ts).
 *
 * Задача L8: 4 дизайни з data/linoleum-photos.json (WHO: оркестратор,
 * файл у gitignored data/ — у тестах зашиті копії рядків), кожен дизайн —
 * ОДНЕ фото на всі width-картки (name = `{design} {width} м`).
 *
 * Контракт під тестом (статика — БД/Storage тестами НЕ торкаються):
 *   - режими --plan (0 записів, без клієнта) та --run; --photos <path>;
 *   - -run: fetch imageUrl (таймаут, content-type image/*, ≤5MB, magic
 *     bytes) -> Storage product_images, шлях linoleum/<slug>.<ext> через
 *     sanitizeUploadFileName (upload-filename) -> public URL для логу
 *     (getPublicImageUrl); у product_images пишеться ВІДНОСНИЙ шлях
 *     (патерн wallpaper-photos та admin-images route);
 *   - прив'язка: products sku LIKE 'ln-%' (LINOLEUM_SKU_LIKE) ІМ'Я яких
 *     починається з design-рядка; ідемпотентно: наявна пара
 *     (product_id, image_url) -> skip; is_main=true лише якщо в товара ще
 *     немає main, інакше false; НІКОЛИ не UPDATE (main-прапор не
 *     перетирається); 23505 -> no-op;
 *   - помилки мережі/CDN — per-design (не фатальні для інших дизайнів),
 *     зведення в кінці; CLI exit 1, якщо ≥1 дизайн провалився;
 *   - пагинація ≤1000 + .order('id'); .in()-чанки ≤200; service-role
 *     клієнт ліниво, persistSession: false.
 *
 * Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEFAULT_PHOTOS_PATH,
  MAX_IMAGE_BYTES,
  PAIR_CHUNK_SIZE,
  PAGE_SIZE,
  STORAGE_BUCKET,
  STORAGE_PREFIX,
  designSlug,
  loadPhotosFile,
  matchDesignProducts,
  parseArgs,
  planDesignRows,
  planPhotos,
  readLocalImage,
  resolveLocalPhotoPath,
  runLinoleumPhotosCli,
  runPhotos,
  storagePathForDesign,
  type DesignPhoto,
  type RunTotals,
} from '../scripts/linoleum-photos.ts';

// ---------------------------------------------------------------------------
// Фікстури — реальні рядки з data/linoleum-photos.json (файл gitignored,
// у тести зашиті копії; якість URL — зона оркестратора, тут лише контракт)
// ---------------------------------------------------------------------------

const DESIGNS = [
  'SUGAR OAK 997L Лінолеум BEAUFLOUR SMARTEX',
  'Warm Oak 090S Лінолеум BEAUFLOUR HIGHTEX',
  'CRACKED OAK 906M Лінолеум BEAUFLOUR PURETEX',
  'LIME OAK 679D Лінолеум BEAUFLOUR INSPIRE',
];

/** Реальний рядок з data/linoleum-photos.json (L10): запис із localPath. */
const LOCAL_DESIGN = 'CRACKED OAK 496M Лінолеум BEAUFLOUR PURETEX';

const EXPECTED_SLUGS = [
  'sugar-oak-997l-beauflour-smartex',
  'warm-oak-090s-beauflour-hightex',
  'cracked-oak-906m-beauflour-puretex',
  'lime-oak-679d-beauflour-inspire',
];

const jpeg = (): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

// ---------------------------------------------------------------------------
// Статичні інваріанти (сирий сорс, коментарі зрізано)
// ---------------------------------------------------------------------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'scripts/linoleum-photos.ts'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('CLI: режими --plan/--run, опція --photos, USAGE', () => {
  assert.match(code, /--plan/);
  assert.match(code, /--run/);
  assert.match(code, /--photos/);
  assert.match(code, /USAGE/);
});

test('CLI: НІЯКИХ .update( / .delete( / .rpc( / .upsert( — main-прапор не перетирається', () => {
  assert.doesNotMatch(code, /\.update\(/);
  assert.doesNotMatch(code, /\.delete\(/);
  assert.doesNotMatch(code, /\.rpc\(/);
  assert.doesNotMatch(code, /\.upsert\(/);
});

test('CLI: service-role клієнт з .env.local, persistSession: false', () => {
  assert.match(code, /\.env\.local/);
  assert.match(code, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(code, /persistSession: false/);
});

test('Storage: bucket product_images, upload з upsert:false, імʼя через sanitizeUploadFileName', () => {
  assert.match(code, /STORAGE_BUCKET = 'product_images'/);
  assert.match(code, /\.storage\.from\(STORAGE_BUCKET\)/);
  assert.match(code, /upsert: false/);
  assert.match(code, /sanitizeUploadFileName/);
  assert.match(code, /IMAGE_EXT_BY_MIME/);
});

test('Storage: у product_images пишеться ВІДНОСНИЙ шлях linoleum/<slug>; public URL — лише для логу', () => {
  assert.match(code, /STORAGE_PREFIX = 'linoleum'/);
  assert.match(
    code,
    /import\s*\{[^}]*getPublicImageUrl[^}]*\}\s*from\s*'\.\.\/app\/lib\/supabase-storage\.ts'/,
  );
});

test('Читання товарів — тільки домен ln-* (LINOLEUM_SKU_LIKE), пагінація ≤1000 + .order(id)', () => {
  assert.match(code, /LINOLEUM_SKU_LIKE/);
  assert.match(
    code,
    /import\s*\{[^}]*LINOLEUM_SKU_LIKE[^}]*\}\s*from\s*'\.\.\/app\/lib\/domains\.ts'/,
  );
  assert.match(code, /PAGE_SIZE = 1000/);
  assert.match(code, /\.order\('id'\)/);
  assert.match(code, /\.range\(from, from \+ PAGE_SIZE - 1\)/);
  assert.match(code, /PAIR_CHUNK_SIZE = 200/);
  assert.doesNotMatch(code, /range\(from, from \+ \d/, 'no literal windows above PAGE_SIZE');
});

test('Завантаження фото: таймаут, content-type image/*, ліміт 5MB, magic bytes', () => {
  assert.match(code, /AbortSignal\.timeout/);
  assert.match(code, /startsWith\('image\/'\)/);
  assert.match(code, /MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/);
  assert.match(code, /detectImageMime/);
});

test('Ідемпотентність: 23505 -> no-op; наявна пара -> skip до INSERT (select перед insert)', () => {
  assert.match(code, /23505/);
  assert.match(code, /\.in\('product_id'/);
});

test('--plan не пише: гілка plan не містить insert/upload/storage/from', () => {
  const planIdx = code.indexOf('function planPhotos');
  const runIdx = code.indexOf('async function runPhotos');
  assert.ok(planIdx !== -1, 'planPhotos exists');
  assert.ok(runIdx !== -1, 'runPhotos exists');
  assert.ok(planIdx < runIdx, 'planPhotos оголошено до runPhotos');
  const planPart = code.slice(planIdx, runIdx);
  assert.doesNotMatch(planPart, /\.insert\(/);
  assert.doesNotMatch(planPart, /\.upload\(/);
  assert.doesNotMatch(planPart, /\.from\(/);
  assert.doesNotMatch(planPart, /createServiceClient/);
});

test('Прямий запуск без сайд-ефектів для тестів (direct-run guard)', () => {
  assert.match(code, /isDirectRun/);
  assert.match(code, /import\.meta\.url/);
});

// ---------------------------------------------------------------------------
// designSlug / storagePathForDesign — санітизація design-рядка
// ---------------------------------------------------------------------------

test('designSlug: кирилиця+латиниця -> латинський slug, 4 реальні дизайни унікальні', () => {
  DESIGNS.forEach((design, i) => {
    assert.equal(designSlug(design), EXPECTED_SLUGS[i], design);
  });
  assert.equal(new Set(EXPECTED_SLUGS).size, 4);
});

test('designSlug: порожній/нелатинський рядок -> fallback "image" (не порожній шлях)', () => {
  assert.equal(designSlug('   '), 'image');
  assert.equal(designSlug('Лінолеум'), 'image');
});

test('storagePathForDesign: linoleum/<slug>.<ext> за whitelist MIME; невідомий MIME -> null', () => {
  assert.equal(storagePathForDesign(DESIGNS[0] ?? '', 'image/jpeg'), `linoleum/${EXPECTED_SLUGS[0]}.jpg`);
  assert.equal(storagePathForDesign(DESIGNS[3] ?? '', 'image/webp'), `linoleum/${EXPECTED_SLUGS[3]}.webp`);
  assert.equal(storagePathForDesign(DESIGNS[0] ?? '', 'text/html'), null);
  assert.equal(storagePathForDesign(DESIGNS[0] ?? '', 'image/svg+xml'), null);
  assert.equal(STORAGE_PREFIX, 'linoleum');
  assert.equal(STORAGE_BUCKET, 'product_images');
});

// ---------------------------------------------------------------------------
// matchDesignProducts — префікс-матч імені
// ---------------------------------------------------------------------------

const product = (id: string, name: string): { id: string; name: string } => ({ id, name });

test('matchDesignProducts: name починається з design — усі ширини дизайну', () => {
  const products = [
    product('p1', `${DESIGNS[0]} 1,5 м`),
    product('p2', `${DESIGNS[0]} 2 м`),
    product('p3', `${DESIGNS[1]} 2,5 м`),
    product('p4', 'Лінолеум Інший'),
  ];
  const matched = matchDesignProducts(DESIGNS[0] ?? '', products);
  assert.deepEqual(matched.map((p) => p.id), ['p1', 'p2']);
});

test('matchDesignProducts: name рівне design (без ширини) теж матчиться', () => {
  const matched = matchDesignProducts(DESIGNS[0] ?? '', [product('p1', DESIGNS[0] ?? '')]);
  assert.deepEqual(matched.map((p) => p.id), ['p1']);
});

test('matchDesignProducts: регістр та під рядок — суворо (не матчить чужі імена)', () => {
  const products = [
    product('p1', 'sugar oak 997l Лінолеум BEAUFLOUR SMARTEX 2 м'), // інший регістр
    product('p2', `Немає ${DESIGNS[0]}`), // design не префікс
  ];
  assert.deepEqual(matchDesignProducts(DESIGNS[0] ?? '', products).map((p) => p.id), []);
});

// ---------------------------------------------------------------------------
// planDesignRows — план ідемпотентності (pairs + mains)
// ---------------------------------------------------------------------------

test('planDesignRows: свіжий продукт без фото -> is_main true, пара пишеться', () => {
  const plan = planDesignRows('linoleum/x.jpg', [product('p1', `${DESIGNS[0]} 2 м`)], DESIGNS[0] ?? '', new Map(), new Set());
  assert.deepEqual(plan.rows, [{ product_id: 'p1', image_url: 'linoleum/x.jpg', is_main: true }]);
  assert.equal(plan.skipped, 0);
});

test('planDesignRows: у продукта вже є main -> нова строка is_main false (main не перетирається)', () => {
  const plan = planDesignRows(
    'linoleum/x.jpg',
    [product('p1', `${DESIGNS[0]} 2 м`)],
    DESIGNS[0] ?? '',
    new Map(),
    new Set(['p1']),
  );
  assert.deepEqual(plan.rows, [{ product_id: 'p1', image_url: 'linoleum/x.jpg', is_main: false }]);
});

test('planDesignRows: наявна пара (product_id, image_url) -> skipped, рядка немає', () => {
  const pairs = new Map([['p1', new Set(['linoleum/x.jpg'])]]);
  const plan = planDesignRows(
    'linoleum/x.jpg',
    [product('p1', `${DESIGNS[0]} 2 м`), product('p2', `${DESIGNS[0]} 3 м`)],
    DESIGNS[0] ?? '',
    pairs,
    new Set(),
  );
  assert.deepEqual(plan.rows, [{ product_id: 'p2', image_url: 'linoleum/x.jpg', is_main: true }]);
  assert.equal(plan.skipped, 1);
});

test('planDesignRows: немає матчів -> порожній план (товарів ln-* ще немає)', () => {
  const plan = planDesignRows('linoleum/x.jpg', [], DESIGNS[0] ?? '', new Map(), new Set());
  assert.deepEqual(plan.rows, []);
  assert.equal(plan.skipped, 0);
});

// ---------------------------------------------------------------------------
// loadPhotosFile — strict whitelist парсинг seed-JSON
// ---------------------------------------------------------------------------

function tmpPhotosFile(payload: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ln-photos-'));
  const file = path.join(dir, 'photos.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

const validPhoto: DesignPhoto = {
  design: DESIGNS[0] ?? '',
  imageUrl: 'https://cdn.example.com/sugar-oak.jpg',
  sourcePage: 'https://example.com/sugar-oak',
};

test('loadPhotosFile: валідний файл {photos:[{design,imageUrl,sourcePage}]}', () => {
  const file = tmpPhotosFile({ comment: 'x', photos: [validPhoto] });
  try {
    assert.deepEqual(loadPhotosFile(file), [validPhoto]);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('loadPhotosFile: бій-кейси -> throw (не масив, кривий запис, не-http URL, дублікат design)', () => {
  const cases: unknown[] = [
    { photos: {} },
    [],
    { photos: [validPhoto, validPhoto] },
    { photos: [{ design: '', imageUrl: 'https://x.com/a.jpg', sourcePage: '' }] },
    { photos: [{ design: 'A', imageUrl: 'ftp://x.com/a.jpg', sourcePage: '' }] },
    { photos: [{ design: 'A', imageUrl: 'https://x.com/a.jpg' }] },
    { photos: [{ design: 'A', imageUrl: 42, sourcePage: '' }] },
    {},
  ];
  for (const [i, payload] of cases.entries()) {
    const file = tmpPhotosFile(payload);
    try {
      assert.throws(() => loadPhotosFile(file), `case ${i}: має кинути: ${JSON.stringify(payload)}`);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// loadPhotosFile / resolveLocalPhotoPath — localPath (задача L10): XOR з
// imageUrl, шлях від кореня репо, ".." і абсолютні шляхи відкидаються
// ---------------------------------------------------------------------------

test('loadPhotosFile: localPath-запис без imageUrl валідний -> {design, localPath, sourcePage}', () => {
  const photo = {
    design: LOCAL_DESIGN,
    localPath: 'data/linoleum-496m.jpg',
    sourcePage: 'локальное фото владельца',
  };
  const file = tmpPhotosFile({ photos: [photo] });
  try {
    assert.deepEqual(loadPhotosFile(file), [photo]);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('loadPhotosFile: XOR imageUrl/localPath — обидва або жодного -> throw', () => {
  const cases: unknown[] = [
    // обидва:
    {
      photos: [
        {
          design: 'A',
          imageUrl: 'https://x.com/a.jpg',
          localPath: 'data/a.jpg',
          sourcePage: '',
        },
      ],
    },
    // жодного:
    { photos: [{ design: 'A', sourcePage: '' }] },
  ];
  for (const [i, payload] of cases.entries()) {
    const file = tmpPhotosFile(payload);
    try {
      assert.throws(
        () => loadPhotosFile(file),
        /localPath|imageUrl/,
        `case ${i}: має кинути (XOR): ${JSON.stringify(payload)}`,
      );
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
});

test('loadPhotosFile: localPath з "..", абсолютний, порожній чи не-рядок -> throw', () => {
  const bad: unknown[] = [
    '../escape.jpg',
    'data/../../escape.jpg',
    'a\\..\\escape.jpg',
    '/etc/passwd.jpg',
    'C:\\abs\\a.jpg',
    '',
    '   ',
    42,
    null,
  ];
  for (const [i, localPath] of bad.entries()) {
    const file = tmpPhotosFile({
      photos: [{ design: 'A', localPath, sourcePage: '' }],
    });
    try {
      assert.throws(() => loadPhotosFile(file), `case ${i}: ${JSON.stringify(localPath)} має кинути`);
    } finally {
      rmSync(path.dirname(file), { recursive: true, force: true });
    }
  }
});

test('resolveLocalPhotoPath: відносний -> base + шлях; ".." і абсолютні -> throw', () => {
  const base = path.join('repo', 'root');
  assert.equal(
    resolveLocalPhotoPath(base, 'data/linoleum-496m.jpg'),
    path.join(base, 'data', 'linoleum-496m.jpg'),
  );
  assert.throws(() => resolveLocalPhotoPath(base, '../escape.jpg'));
  assert.throws(() => resolveLocalPhotoPath(base, 'a/../../escape.jpg'));
  assert.throws(() => resolveLocalPhotoPath(base, 'a\\..\\escape.jpg'));
  assert.throws(() => resolveLocalPhotoPath(base, '/abs/x.jpg'));
  if (process.platform === 'win32') {
    assert.throws(() => resolveLocalPhotoPath(base, 'C:\\abs\\x.jpg'));
  }
});

test('readLocalImage: існуючий файл -> байти; відсутній -> throw з внятним повідомленням', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ln-photos-read-'));
  try {
    const file = path.join(dir, 'a.jpg');
    writeFileSync(file, jpeg());
    const bytes = readLocalImage(file);
    assert.deepEqual([...bytes], [...jpeg()]);
    assert.throws(() => readLocalImage(path.join(dir, 'no-such.jpg')), /не вдалося прочитати локальний файл/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planPhotos: localPath-запис — файл існує -> у плані localPath+розмір; відсутній -> throw', () => {
  const okFile = tmpPhotosFile({
    photos: [{ design: LOCAL_DESIGN, localPath: 'public/og-image.png', sourcePage: 'x' }],
  });
  const okLog: string[] = [];
  try {
    planPhotos(okFile, (line) => okLog.push(line));
    assert.ok(
      okLog.some((l) => l.includes('localPath') && l.includes('og-image.png')),
      'план має згадати localPath',
    );
  } finally {
    rmSync(path.dirname(okFile), { recursive: true, force: true });
  }

  const missingFile = tmpPhotosFile({
    photos: [{ design: LOCAL_DESIGN, localPath: 'data/no-such-3b1f.jpg', sourcePage: 'x' }],
  });
  try {
    assert.throws(() => planPhotos(missingFile, () => {}), /локальний файл не знайдено/);
  } finally {
    rmSync(path.dirname(missingFile), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: --plan / --run, --photos опція; змішування/пусто/невідоме -> throw', () => {
  assert.deepEqual(parseArgs(['--plan']), { mode: 'plan' });
  assert.deepEqual(parseArgs(['--run']), { mode: 'run' });
  assert.deepEqual(parseArgs(['--run', '--photos', 'data/x.json']), {
    mode: 'run',
    photos: 'data/x.json',
  });
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--plan', '--run']));
  assert.throws(() => parseArgs(['--plan', '--photos', 'x.json', '--dry']));
  assert.throws(() => parseArgs(['--publish']));
});

// ---------------------------------------------------------------------------
// runPhotos — runtime на fake-клієнті (БД/Storage/мережа — in-memory)
// ---------------------------------------------------------------------------

interface FakeImageRow {
  product_id: string;
  image_url: string;
  is_main: boolean;
}

interface FakeDbState {
  products: { id: string; sku: string; name: string }[];
  images: FakeImageRow[];
  storagePaths: string[];
}

type RecordedInsert = FakeImageRow;

interface RecordedUpload {
  path: string;
  contentType: string;
  upsert: boolean;
}

function makeFakeDb(state: FakeDbState): {
  client: SupabaseClient;
  inserts: RecordedInsert[];
  uploads: RecordedUpload[];
} {
  const inserts: RecordedInsert[] = [];
  const uploads: RecordedUpload[] = [];
  const client = {
    from(table: string) {
      let insertRow: FakeImageRow | null = null;
      let inIds: string[] = [];
      let win: [number, number] = [0, 0];
      const execute = (): Promise<{
        data: FakeImageRow[] | { id: string; sku: string; name: string }[] | null;
        error: { message: string } | null;
      }> => {
        if (insertRow !== null) {
          const row = insertRow;
          const dup = state.images.some(
            (i) => i.product_id === row.product_id && i.image_url === row.image_url,
          );
          if (dup) {
            return Promise.resolve({
              data: null,
              error: {
                message:
                  'duplicate key value violates unique constraint "idx_product_images_product_url"',
              },
            });
          }
          state.images.push({ ...row });
          inserts.push({ ...row });
          return Promise.resolve({ data: null, error: null });
        }
        if (table === 'products') {
          return Promise.resolve({
            data: state.products.slice(win[0], win[1] + 1),
            error: null,
          });
        }
        if (table === 'product_images') {
          const filtered = state.images.filter((i) => inIds.includes(i.product_id));
          return Promise.resolve({
            data: filtered.slice(win[0], win[1] + 1),
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: { message: `unexpected table ${table}` } });
      };
      const b = {
        select() {
          return b;
        },
        like() {
          return b;
        },
        in(_col: string, ids: readonly string[]) {
          inIds = [...ids];
          return b;
        },
        order() {
          return b;
        },
        range(from: number, to: number) {
          win = [from, to];
          return b;
        },
        insert(row: FakeImageRow) {
          insertRow = row;
          return b;
        },
        returns<T>(): PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
          return execute() as Promise<{ data: T[] | null; error: { message: string } | null }>;
        },
        // PostgrestBuilder-сумісність: insert() можна awaitити без .returns().
        then<T>(
          onFulfilled?: (value: { data: unknown; error: { message: string } | null }) => T,
          onRejected?: (reason: unknown) => T,
        ): PromiseLike<T> {
          return execute().then(onFulfilled, onRejected);
        },
      };
      return b;
    },
    storage: {
      from(_bucket: string) {
        return {
          upload(
            storagePath: string,
            _bytes: Uint8Array,
            opts: { contentType: string; upsert: boolean },
          ) {
            uploads.push({ path: storagePath, contentType: opts.contentType, upsert: opts.upsert });
            if (state.storagePaths.includes(storagePath)) {
              return Promise.resolve({ error: { message: 'Duplicate: already exists' } });
            }
            state.storagePaths.push(storagePath);
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  };
  return { client: client as unknown as SupabaseClient, inserts, uploads };
}

const lnProduct = (id: string, design: string, width: string): {
  id: string;
  sku: string;
  name: string;
} => ({ id, sku: `ln-x-${id}`, name: `${design} ${width} м` });

interface RunFixture {
  state: FakeDbState;
  db: ReturnType<typeof makeFakeDb>;
  log: string[];
  photos: DesignPhoto[];
  photosPath: string;
}

function makeFixture(): RunFixture {
  const state: FakeDbState = {
    products: [
      lnProduct('s15', DESIGNS[0] ?? '', '1,5'),
      lnProduct('s20', DESIGNS[0] ?? '', '2'),
      lnProduct('w25', DESIGNS[1] ?? '', '2,5'),
      lnProduct('other', 'Лінолеум Чужий Дизайн', '3'),
    ],
    images: [],
    storagePaths: [],
  };
  const db = makeFakeDb(state);
  const log: string[] = [];
  const photos: DesignPhoto[] = [
    {
      design: DESIGNS[0] ?? '',
      imageUrl: 'https://cdn.example.com/sugar-oak.jpg',
      sourcePage: 'https://example.com/sugar-oak',
    },
    {
      design: DESIGNS[1] ?? '',
      imageUrl: 'https://cdn.example.com/warm-oak.webp',
      sourcePage: 'https://example.com/warm-oak',
    },
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'ln-photos-run-'));
  const photosPath = path.join(dir, 'photos.json');
  writeFileSync(photosPath, JSON.stringify({ photos }));
  return { state, db, log, photos, photosPath };
}

test('runPhotos: щасливий шлях — 1 upload на дизайн (шлях linoleum/<slug>, content-type за magic bytes), attach по префіксу, is_main по mains', async () => {
  const fx = makeFixture();
  const fetchedUrls: string[] = [];
  const totals = await runPhotos(
    { photosPath: fx.photosPath },
    {
      client: fx.db.client,
      throttleMs: 0,
      log: (line) => fx.log.push(line),
      fetchImage: async (url) => {
        fetchedUrls.push(url);
        return {
          bytes: url.endsWith('.webp')
            ? new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])
            : jpeg(),
          contentType: 'image/jpeg', // бреше для webp — extension береться з magic bytes
        };
      },
    },
  );

  assert.deepEqual(totals.failed, []);
  const sugar = totals.designs.find((d) => d.design === DESIGNS[0]);
  const warm = totals.designs.find((d) => d.design === DESIGNS[1]);
  assert.deepEqual(sugar, { design: DESIGNS[0], matchedProducts: 2, attached: 2, skipped: 0 });
  assert.deepEqual(warm, { design: DESIGNS[1], matchedProducts: 1, attached: 1, skipped: 0 });

  // Рівно один fetch на дизайн (чужий дизайн не чіпається)
  assert.deepEqual(fetchedUrls, fx.photos.map((p) => p.imageUrl));

  // Upload: шлях linoleum/<slug>.<ext за magic bytes>, upsert:false
  assert.deepEqual(
    fx.db.uploads.map((u) => [u.path, u.contentType, u.upsert]),
    [
      [`linoleum/${EXPECTED_SLUGS[0]}.jpg`, 'image/jpeg', false],
      [`linoleum/${EXPECTED_SLUGS[1]}.webp`, 'image/webp', false],
    ],
  );

  // Inserts: 3 (2 ширини sugar + 1 warm), is_main true (ніхто не мав main)
  assert.deepEqual(
    fx.db.inserts.map((i) => [i.image_url, i.is_main]),
    [
      [`linoleum/${EXPECTED_SLUGS[0]}.jpg`, true],
      [`linoleum/${EXPECTED_SLUGS[0]}.jpg`, true],
      [`linoleum/${EXPECTED_SLUGS[1]}.webp`, true],
    ],
  );
  // Чужий дизайн не отримав нічого
  assert.equal(fx.db.inserts.some((i) => i.product_id === 'other'), false);
});

test('runPhotos: ідемпотентний повтор — пари існують -> 0 inserts, усі skipped; Storage already-exists толерується', async () => {
  const fx = makeFixture();
  const deps = {
    client: fx.db.client,
    throttleMs: 0,
    log: (line: string) => fx.log.push(line),
    fetchImage: async () => ({ bytes: jpeg(), contentType: 'image/jpeg' }),
  };
  await runPhotos({ photosPath: fx.photosPath }, deps);
  const firstCount = fx.db.inserts.length;
  assert.equal(firstCount, 3);

  const second = await runPhotos({ photosPath: fx.photosPath }, deps);
  assert.equal(fx.db.inserts.length, firstCount, '0 нових inserts');
  const sugar = second.designs.find((d) => d.design === DESIGNS[0]);
  const warm = second.designs.find((d) => d.design === DESIGNS[1]);
  assert.deepEqual(sugar, { design: DESIGNS[0], matchedProducts: 2, attached: 0, skipped: 2 });
  assert.deepEqual(warm, { design: DESIGNS[1], matchedProducts: 1, attached: 0, skipped: 1 });
  assert.deepEqual(second.failed, []);
  // Storage already-exists не валить дизайн (orphan-обʼєкт попереднього запуску)
  assert.ok(fx.db.uploads.every((u) => u.upsert === false));
});

test('runPhotos: наявний main у товара -> is_main false; нова пара пишється поруч', async () => {
  const fx = makeFixture();
  fx.state.images.push({
    product_id: 's15',
    image_url: 'products/manual/old.jpg',
    is_main: true,
  });
  await runPhotos(
    { photosPath: fx.photosPath },
    {
      client: fx.db.client,
      throttleMs: 0,
      log: () => {},
      fetchImage: async () => ({ bytes: jpeg(), contentType: 'image/jpeg' }),
    },
  );
  const s15 = fx.db.inserts.find((i) => i.product_id === 's15');
  const s20 = fx.db.inserts.find((i) => i.product_id === 's20');
  assert.equal(s15?.is_main, false, 'існуючий main не перетирається');
  assert.equal(s20?.is_main, true, 'продукт без main отримує main');
});

test('runPhotos: збій одного дизайну (мережа) не валить інші; totals.failed + CLI exit 1', async () => {
  const fx = makeFixture();
  const totals = await runPhotos(
    { photosPath: fx.photosPath },
    {
      client: fx.db.client,
      throttleMs: 0,
      log: (line) => fx.log.push(line),
      fetchImage: async (url) => {
        if (url.includes('sugar-oak')) throw new Error('ETIMEDOUT');
        return { bytes: jpeg(), contentType: 'image/jpeg' };
      },
    },
  );
  assert.equal(totals.designs.find((d) => d.design === DESIGNS[1])?.attached, 1);
  assert.equal(totals.failed.length, 1);
  assert.equal(totals.failed[0]?.design, DESIGNS[0]);
  assert.match(totals.failed[0]?.reason ?? '', /ETIMEDOUT/);
  assert.ok(fx.log.some((l) => l.includes(DESIGNS[0] ?? '') && l.includes('ETIMEDOUT')));

  const exit = await runLinoleumPhotosCli(['--run', '--photos', fx.photosPath], {
    client: fx.db.client,
    throttleMs: 0,
    log: () => {},
    fetchImage: async (url) => {
      if (url.includes('sugar-oak')) throw new Error('ETIMEDOUT');
      return { bytes: jpeg(), contentType: 'image/jpeg' };
    },
  });
  assert.equal(exit, 1, '≥1 провалений дизайн -> exit 1');
});

test('runPhotos: гарди — не-image content-type, >5MB, magic bytes не зображення -> failed, без записів', async () => {
  const cases: { bytes: Uint8Array; contentType: string }[] = [
    { bytes: jpeg(), contentType: 'text/html' },
    { bytes: new Uint8Array(MAX_IMAGE_BYTES + 1), contentType: 'image/jpeg' },
    { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: 'image/jpeg' }, // %PDF
  ];
  for (const [i, fetched] of cases.entries()) {
    const fx = makeFixture();
    const totals = await runPhotos(
      { photosPath: fx.photosPath },
      {
        client: fx.db.client,
        throttleMs: 0,
        log: () => {},
        // Гард падає ЛИШЕ на першому дизайні (sugar-oak), другий — валідний jpeg.
        fetchImage: async (url) =>
          url.includes('sugar-oak') ? fetched : { bytes: jpeg(), contentType: 'image/jpeg' },
      },
    );
    assert.equal(totals.failed.length, 1, `case ${i}`);
    assert.equal(totals.failed[0]?.design, DESIGNS[0], `case ${i}`);
    // провалений дизайн не пише НІЧОГО (ні Storage, ні product_images)…
    const sugarPath = `linoleum/${EXPECTED_SLUGS[0]}`;
    assert.equal(
      fx.db.uploads.some((u) => u.path.startsWith(sugarPath)),
      false,
      `case ${i}: без upload`,
    );
    assert.equal(
      fx.db.inserts.some((r) => r.image_url.startsWith(sugarPath)),
      false,
      `case ${i}: жодних записів`,
    );
    // …а другий дизайн (ok) продовжує писатись
    assert.equal(totals.designs.find((d) => d.design === DESIGNS[1])?.attached, 1, `case ${i}`);
  }
});

test('runPhotos: ln-* товарів немає -> 0 мережевих дій неминуче, designs з matchedProducts 0, exit 0', async () => {
  const fx = makeFixture();
  fx.state.products = [];
  let fetchCalls = 0;
  const totals = await runPhotos(
    { photosPath: fx.photosPath },
    {
      client: fx.db.client,
      throttleMs: 0,
      log: () => {},
      fetchImage: async () => {
        fetchCalls += 1;
        return { bytes: jpeg(), contentType: 'image/jpeg' };
      },
    },
  );
  assert.equal(fetchCalls, 2, 'design все одно верифікується завантаженням');
  assert.ok(totals.designs.every((d) => d.matchedProducts === 0 && d.attached === 0));
  assert.deepEqual(totals.failed, []);
});

// ---------------------------------------------------------------------------
// localPath-гілка (задача L10): readFileSync замість fetch, спільні гарди
// ---------------------------------------------------------------------------

test('source-pin: runPhotos має гілку localPath (readLocalImage/readFileSync) і спільні гарди після неї', () => {
  assert.match(code, /if \(photo\.localPath !== undefined\)/);
  assert.match(code, /readLocalImage\(/);
  // fetch-шов лишається лише для http-гілки:
  assert.match(code, /await fetchImage\(photo\.imageUrl\)/);
  // Гарди розміру та magic bytes — спільні, ПІСЛЯ гілки localPath. Індекси —
  // по сирому сорсу: naive-стриппер коментарів вище (`code`) ковтає `image/*`
  // у template-рядку помилки як початок block-коментаря (артефакт стриппера).
  const branchIdx = src.indexOf('if (photo.localPath !== undefined)');
  const sizeGuardIdx = src.indexOf('if (bytes.byteLength > MAX_IMAGE_BYTES)');
  const mimeGuardIdx = src.indexOf('const mime = detectImageMime(bytes);');
  assert.ok(branchIdx !== -1, 'гілка localPath у runPhotos');
  assert.ok(sizeGuardIdx > branchIdx, 'гард розміру — спільний (після гілки)');
  assert.ok(mimeGuardIdx > branchIdx, 'гард magic bytes — спільний (після гілки)');
});

test('runPhotos: localPath (readFileSync-гілка) — upload за magic bytes, fetchImage НЕ викликається', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ln-photos-local-'));
  const photosPath = path.join(dir, 'photos.json');
  // Фікстура — реальний комітований дрібний png у репо (шлях від кореня репо).
  const localSlug = designSlug(LOCAL_DESIGN);
  assert.equal(localSlug, 'cracked-oak-496m-beauflour-puretex');
  writeFileSync(
    photosPath,
    JSON.stringify({
      photos: [
        { design: LOCAL_DESIGN, localPath: 'public/og-image.png', sourcePage: 'локальное фото' },
      ],
    }),
  );
  try {
    const state: FakeDbState = {
      products: [lnProduct('c25', LOCAL_DESIGN, '2,5')],
      images: [],
      storagePaths: [],
    };
    const db = makeFakeDb(state);
    let fetchCalls = 0;
    const totals = await runPhotos({ photosPath }, {
      client: db.client,
      throttleMs: 0,
      log: () => {},
      fetchImage: async () => {
        fetchCalls += 1;
        return { bytes: jpeg(), contentType: 'image/jpeg' };
      },
    });
    assert.deepEqual(totals.failed, []);
    assert.equal(fetchCalls, 0, 'localPath не ходить у мережу');
    assert.deepEqual(totals.designs, [
      { design: LOCAL_DESIGN, matchedProducts: 1, attached: 1, skipped: 0 },
    ]);
    // MIME — за magic bytes PNG (не з розширення джерела), ext .png:
    assert.deepEqual(db.uploads, [
      { path: `linoleum/${localSlug}.png`, contentType: 'image/png', upsert: false },
    ]);
    assert.deepEqual(db.inserts, [
      {
        product_id: 'c25',
        image_url: `linoleum/${localSlug}.png`,
        is_main: true,
        sort_order: 0,
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPhotos: відсутній локальний файл -> failed дизайн, 0 записів', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ln-photos-miss-'));
  const photosPath = path.join(dir, 'photos.json');
  writeFileSync(
    photosPath,
    JSON.stringify({
      photos: [
        { design: LOCAL_DESIGN, localPath: 'data/no-such-3b1f.jpg', sourcePage: 'x' },
      ],
    }),
  );
  try {
    const state: FakeDbState = {
      products: [lnProduct('c25', LOCAL_DESIGN, '2,5')],
      images: [],
      storagePaths: [],
    };
    const db = makeFakeDb(state);
    const totals = await runPhotos({ photosPath }, {
      client: db.client,
      throttleMs: 0,
      log: () => {},
      fetchImage: async () => ({ bytes: jpeg(), contentType: 'image/jpeg' }),
    });
    assert.equal(totals.failed.length, 1);
    assert.equal(totals.failed[0]?.design, LOCAL_DESIGN);
    assert.match(totals.failed[0]?.reason ?? '', /не вдалося прочитати локальний файл/);
    assert.equal(db.uploads.length, 0, 'без upload');
    assert.equal(db.inserts.length, 0, 'жодних записів');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLinoleumPhotosCli: --plan друкує плани і пише НУЛЬ; клієнт не чіпається', async () => {
  const fx = makeFixture();
  const { client, inserts, uploads } = fx.db;
  const probed: string[] = [];
  const spy = {
    get queried() {
      return probed.length;
    },
  };
  void spy;
  const exit = await runLinoleumPhotosCli(['--plan', '--photos', fx.photosPath], {
    client,
    log: (line) => fx.log.push(line),
  });
  assert.equal(exit, 0);
  assert.equal(inserts.length, 0);
  assert.equal(uploads.length, 0);
  assert.ok(fx.log.some((l) => l.includes(DESIGNS[0] ?? '')));
  assert.ok(fx.log.some((l) => l.includes(`linoleum/${EXPECTED_SLUGS[0]}`)));
  assert.ok(fx.log.some((l) => l.includes('product_images')));
  // plan не робить запитів у БД: навіть state.images/products не чіпались би.
  // (Перевірка через те, що клієнт у deps НЕ викликається: передамо client,
  // що кидає на будь-який from.)
  const exploding = {
    from: () => {
      probed.push('from');
      throw new Error('plan must not touch DB');
    },
  } as unknown as SupabaseClient;
  const exit2 = await runLinoleumPhotosCli(['--plan', '--photos', fx.photosPath], {
    client: exploding,
    log: () => {},
  });
  assert.equal(exit2, 0);
  assert.equal(probed.length, 0);
});

test('Константи: PAGE_SIZE 1000, PAIR_CHUNK_SIZE 200, MAX_IMAGE_BYTES 5MB, DEFAULT_PHOTOS_PATH у data/', () => {
  assert.equal(PAGE_SIZE, 1000);
  assert.equal(PAIR_CHUNK_SIZE, 200);
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.ok(DEFAULT_PHOTOS_PATH.includes(`data${path.sep}linoleum-photos.json`));
});

test('RunTotals-контракт: designs[] + failed[] (зведення в кінці)', () => {
  const totals: RunTotals = {
    designs: [{ design: 'd', matchedProducts: 1, attached: 1, skipped: 0 }],
    failed: [],
  };
  assert.equal(totals.designs.length, 1);
});
