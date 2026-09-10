/**
 * Task 4 (wallpapers import): категории — маппинг подгрупп отчёта 1С
 * на витринные категории сайта + pure-план upsert.
 *
 * Полностью чистые тесты: никаких БД/Next/секретов — только pure-модуль
 * app/lib/wallpapers/categories.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLPAPER_ROOT,
  WALLPAPER_CATEGORY_MAP,
  planCategoryUpsert,
  type ExistingWallpaperCategory,
} from '../app/lib/wallpapers/categories.ts';

// Ключ = подгруппа из отчёта 1С ТОЧНО как в файле (ru, регистр сохранён).
const EXPECTED_MAP: Record<string, { name: string; slug: string }> = {
  Акрил: { name: 'Акрил', slug: 'shpaleri-akryl' },
  'Винил 10 м': { name: 'Вініл 10 м', slug: 'shpaleri-vinyl-10m' },
  'Винил 15 м': { name: 'Вініл 15 м', slug: 'shpaleri-vinyl-15m' },
  Дуплекс: { name: 'Дуплекс', slug: 'shpaleri-duplex' },
  Метровые: { name: 'Метрові', slug: 'shpaleri-metrovi' },
  ФЛИЗЕЛИН: { name: 'Флізелін', slug: 'shpaleri-flizelin' },
  ШЕЛКОГРАФИЯ: { name: 'Шовкографія', slug: 'shpaleri-shovkografiya' },
  'Мойка простая': { name: 'Мійка проста', slug: 'shpaleri-miika-prosta' },
  'Обои простые': { name: 'Прості шпалери', slug: 'shpaleri-prosti' },
  Супермойка: { name: 'Супермійка', slug: 'shpaleri-supermiika' },
};

function row(
  id: string,
  slug: string,
  name: string,
  parentId: string | null
): ExistingWallpaperCategory {
  return { id, slug, name, parentId };
}

/** Имитирует исполнение плана: создаёт строки с id и возвращает existing. */
function simulateApply(
  plan: ReturnType<typeof planCategoryUpsert>,
  prefix: string
): ExistingWallpaperCategory[] {
  const rows: ExistingWallpaperCategory[] = [];
  let i = 0;
  for (const create of plan.creates) {
    i += 1;
    const id = `${prefix}-${i}`;
    const parentId =
      create.parentSlug === null
        ? null
        : (rows.find((r) => r.slug === create.parentSlug)?.id ?? null);
    rows.push(row(id, create.slug, create.name, parentId));
  }
  return rows;
}

test('WALLPAPER-CATEGORIES: корень «Шпалери» / shpaleri', () => {
  assert.deepEqual(WALLPAPER_ROOT, { name: 'Шпалери', slug: 'shpaleri' });
});

test('WALLPAPER-CATEGORIES: маппинг полон — ровно 10 подгрупп отчёта 1С', () => {
  const keys = Object.keys(WALLPAPER_CATEGORY_MAP);
  assert.equal(keys.length, 10);
  assert.deepEqual([...keys].sort(), [...Object.keys(EXPECTED_MAP)].sort());
  // порядок = порядок отчёта 1С (детерминированный вывод плана)
  assert.deepEqual(keys, Object.keys(EXPECTED_MAP));
});

test('WALLPAPER-CATEGORIES: uk-имена и slugs точно соответствуют списку', () => {
  assert.deepEqual(WALLPAPER_CATEGORY_MAP, EXPECTED_MAP);
  const slugs = Object.values(WALLPAPER_CATEGORY_MAP).map((c) => c.slug);
  assert.equal(new Set(slugs).size, 10, 'slugs уникальны');
  assert.ok(!slugs.includes(WALLPAPER_ROOT.slug), 'slugs детей не пересекаются с корнем');
});

test('PLAN: пустая БД → 11 creates (корень + 10), links = {}, conflicts = []', () => {
  const plan = planCategoryUpsert([]);
  assert.deepEqual(plan.links, {});
  assert.deepEqual(plan.conflicts, []);

  // корень первый, parentSlug = null
  assert.equal(plan.creates.length, 11);
  assert.deepEqual(plan.creates[0], {
    slug: 'shpaleri',
    name: 'Шпалери',
    parentSlug: null,
  });
  // все 10 детей ссылаются на корень, в порядке отчёта 1С
  const children = plan.creates.slice(1);
  assert.deepEqual(
    children.map((c) => [c.slug, c.name, c.parentSlug]),
    Object.values(EXPECTED_MAP).map((c) => [c.slug, c.name, 'shpaleri'])
  );
});

test('PLAN: идемпотентность — повторный вызов после применения → creates = [], все links', () => {
  const first = planCategoryUpsert([]);
  const existing = simulateApply(first, 'cat');
  assert.equal(existing.length, 11);

  const second = planCategoryUpsert(existing);
  assert.deepEqual(second.creates, []);
  assert.deepEqual(second.conflicts, []);
  const expectedLinks: Record<string, string> = {};
  Object.entries(EXPECTED_MAP).forEach(([key], idx) => {
    expectedLinks[key] = `cat-${idx + 2}`; // дети созданы после корня
  });
  assert.deepEqual(second.links, expectedLinks);
});

test('PLAN: reuse — существующие slug+имя переиспользуются (регистр и ru-вариант)', () => {
  const existing: ExistingWallpaperCategory[] = [
    row('root-1', 'shpaleri', 'ШПАЛЕРИ', null), // регистр не важен
    row('flz-1', 'shpaleri-flizelin', 'ФЛИЗЕЛИН', 'root-1'), // ключ 1С как есть
    row('vin-1', 'shpaleri-vinyl-10m', 'Винил 10 м', 'root-1'), // рус. написание
    row('shv-1', 'shpaleri-shovkografiya', 'Шовкографія', 'root-1'), // uk витринное
  ];
  const plan = planCategoryUpsert(existing);
  assert.deepEqual(plan.conflicts, []);
  // корень + 3 переиспользованных → создаём только 7 детей
  assert.equal(plan.creates.length, 7);
  assert.deepEqual(
    plan.creates.map((c) => c.slug),
    [
      'shpaleri-akryl',
      'shpaleri-vinyl-15m',
      'shpaleri-duplex',
      'shpaleri-metrovi',
      'shpaleri-miika-prosta',
      'shpaleri-prosti',
      'shpaleri-supermiika',
    ]
  );
  assert.deepEqual(plan.links, {
    'Винил 10 м': 'vin-1',
    ФЛИЗЕЛИН: 'flz-1',
    ШЕЛКОГРАФИЯ: 'shv-1',
  });
});

test('PLAN: конфликт — slug занят категорией с кардинально другим именем', () => {
  const existing: ExistingWallpaperCategory[] = [
    row('root-1', 'shpaleri', 'Шпалери', null),
    row('alien-1', 'shpaleri-akryl', 'Фарба акрилова будівельна', 'root-1'),
  ];
  const plan = planCategoryUpsert(existing);
  assert.deepEqual(plan.conflicts, ['shpaleri-akryl']);
  // конфликтную категорию не трогаем: ни create, ни link
  assert.ok(!plan.creates.some((c) => c.slug === 'shpaleri-akryl'));
  assert.ok(!('Акрил' in plan.links));
  // остальные 9 детей планируются как обычно
  assert.equal(plan.creates.length, 9);
  assert.equal(Object.keys(plan.links).length, 0);
});

test('PLAN: конфликт корня — корень не трогаем, дети планируются (решает executor)', () => {
  const existing: ExistingWallpaperCategory[] = [
    row('alien-root', 'shpaleri', 'Постеры', null),
  ];
  const plan = planCategoryUpsert(existing);
  assert.deepEqual(plan.conflicts, ['shpaleri']);
  assert.ok(!plan.creates.some((c) => c.slug === 'shpaleri'));
  assert.equal(plan.creates.length, 10);
});

test('PLAN: чистая функция — тот же вход даёт тот же план', () => {
  const a = planCategoryUpsert([]);
  const b = planCategoryUpsert([]);
  assert.deepEqual(a, b);
});
