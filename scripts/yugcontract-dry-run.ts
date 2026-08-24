/**
 * READ-ONLY dry-run of the future Yugcontract import, limited to the
 * user-approved category selection (see app/lib/yugcontract/selection.ts).
 *
 * What it does:
 *   1. Loads .env.local (server-side keys never printed).
 *   2. Fetches get-categories and expands the approved selection into
 *      full subtrees (validates every id against the live tree).
 *   3. Fetches get-price per category batch (cats parameter), measures
 *      real payload sizes and durations.
 *   4. Merges products without duplicates (identity = Yugcontract id),
 *      plus a client-side safety filter so nothing outside the approved
 *      selection can reach the report even if the API ignores cats.
 *   5. SELECT-only comparison with our database.
 *
 * What it NEVER does: writes to products/categories/brands/orders,
 * migrations, credential printing. DATABASE CHANGES = none by design.
 *
 * Usage: node scripts/yugcontract-dry-run.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader (KEY=VALUE lines), so no extra dependency.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

const { getPriceCatalogWithMeta, getCategoriesCatalog } = await import(
  '../app/lib/yugcontract/client.ts'
);
const {
  extractRawProducts,
  extractCategoryRows,
  detectCategoryFields,
  normalizeCategoryNode,
} = await import('../app/lib/yugcontract/normalize.ts');
const { createClient } = await import('@supabase/supabase-js');
const {
  SELECTED_CATEGORIES,
  flattenSelectedIds,
  countSelectedNodes,
} = await import('../app/lib/yugcontract/selection.ts');
const {
  YcProductMerger,
  makeCategoryFilter,
  computeDryRunReport,
} = await import('../app/lib/yugcontract/dry-run.ts');

// --- tunables --------------------------------------------------------------
const CATS_PER_BATCH = 40;
const DELAY_BETWEEN_BATCHES_MS = 700;
// PostgREST caps any single response at 1000 rows — PAGE_SIZE must stay <= 1000.
const PAGE_SIZE = 1000;

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : String(n);
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

interface BatchStat {
  index: number;
  catsCount: number;
  rows: number;
  byteLength: number;
  durationMs: number;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // ---- 1. live category tree -> subtree expansion -------------------------
  console.log('== Крок 1/5: дерево категорій get-categories ==');
  const catStartedAt = Date.now();
  const catParsed = await getCategoriesCatalog();
  const { rows: catRows } = extractCategoryRows(catParsed);
  const catFields = detectCategoryFields(catRows);
  const nodes = catRows.map((row) => normalizeCategoryNode(row, catFields));
  const nodeById = new Map(nodes.map((n) => [n.externalId, n]));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n.externalId);
    else childrenOf.set(n.parentId, [n.externalId]);
  }

  const selectedCount = countSelectedNodes(SELECTED_CATEGORIES);
  const selectedIds = flattenSelectedIds(SELECTED_CATEGORIES);
  const expanded = new Set<string>();
  const unknownSelected: string[] = [];
  for (const id of selectedIds) {
    if (!nodeById.has(id)) {
      unknownSelected.push(id);
      continue;
    }
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (expanded.has(cur)) continue;
      expanded.add(cur);
      for (const child of childrenOf.get(cur) ?? []) stack.push(child);
    }
  }
  // Leaf-only request strategy: the API expands every requested id to its
  // whole subtree, so sending parents alongside leaves makes the same
  // product come back in several batches (cross-request duplication).
  // Leaves are disjoint -> each product arrives exactly once per batch run.
  const leafCats = [...expanded].filter((id) => (childrenOf.get(id)?.length ?? 0) === 0);
  console.log(
    `  вузлів у дереві: ${nodes.length}; вибрано: ${selectedCount}` +
      `; розгорнуто (з нащадками): ${expanded.size}; листових для запитів: ${leafCats.length}` +
      (unknownSelected.length > 0
        ? ` ; НЕЗНАЙДЕНО ID: ${unknownSelected.join(', ')}`
        : '')
  );
  console.log(`  час: ${Date.now() - catStartedAt} мс\n`);

  if (expanded.size === 0) {
    throw new Error('Жодну з вибраних категорій не знайдено в дереві постачальника');
  }

  // ---- 2. DB snapshot (SELECT only) ---------------------------------------
  console.log('== Крок 2/5: знімок нашої БД (тільки SELECT) ==');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Немає SUPABASE env-змінних для читання нашої БД');
  }
  const dbClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  async function fetchAll<T>(table: string, select: string): Promise<T[]> {
    const rows: T[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await dbClient
        .from(table)
        .select(select)
        // Stable multi-page windows: OFFSET paging without ORDER BY can
        // return overlapping/gapped pages (live-verified). All tables
        // read here (products/brands/categories) have an `id` PK.
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<T[]>();
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE_SIZE) return rows;
      from += PAGE_SIZE;
    }
  }

  interface ProductRowLite {
    sku: string;
    name: string;
  }
  let hasYcColumn = true;
  let productRows: ProductRowLite[];
  try {
    productRows = await fetchAll<ProductRowLite & { yugcontract_id: string | null }>(
      'products',
      'sku,name,yugcontract_id'
    );
  } catch {
    hasYcColumn = false;
    productRows = await fetchAll<ProductRowLite>('products', 'sku,name');
  }
  const brandRows = await fetchAll<{ name: string }>('brands', 'name');
  const categoryRows = await fetchAll<{ name: string }>('categories', 'name');
  console.log(
    `  products: ${productRows.length}, brands: ${brandRows.length}, categories: ${categoryRows.length}`
  );
  console.log(
    hasYcColumn
      ? '  колонка products.yugcontract_id: існує'
      : "  колонки products.yugcontract_id НЕМАЄ (збіг існуючих — лише через sku)"
  );
  console.log('');

  // ---- 3. batched get-price over leaf categories ---------------------------
  console.log('== Крок 3/5: get-price батчами (тільки листові cats) ==');
  const expandedList = [...expanded].sort((a, b) => Number(a) - Number(b));
  const batches: string[][] = [];
  for (let i = 0; i < leafCats.length; i += CATS_PER_BATCH) {
    batches.push(leafCats.slice(i, i + CATS_PER_BATCH));
  }
  console.log(`  батчів: ${batches.length} (по ≤${CATS_PER_BATCH} cats)\n`);

  const merger = new YcProductMerger();
  const keepInSelection = makeCategoryFilter(expanded);
  let totalBytes = 0;
  let priceDurationMs = 0;
  const batchStats: BatchStat[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batchCats = batches[i].map(Number);
    const t0 = Date.now();
    const { parsed, byteLength } = await getPriceCatalogWithMeta({
      cats: batchCats,
    });
    const rawProducts = extractRawProducts(parsed);
    const durationMs = Date.now() - t0;
    merger.addRawBatch(rawProducts);

    totalBytes += byteLength;
    priceDurationMs += durationMs;
    batchStats.push({
      index: i + 1,
      catsCount: batchCats.length,
      rows: rawProducts.length,
      byteLength,
      durationMs,
    });
    console.log(
      `  батч ${i + 1}/${batches.length}: cats=${batchCats.length}, рядків=${rawProducts.length}, ${humanBytes(byteLength)}, ${durationMs} мс`
    );

    if (i < batches.length - 1) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
    }
  }
  console.log('');

  // client-side safety filter + report
  const keptProducts = merger.values().filter(keepInSelection);
  const filteredOutByCats = merger.uniqueCount - keptProducts.length;

  const report = computeDryRunReport(
    keptProducts,
    {
      totalRows: merger.totalRows,
      duplicateRows: merger.duplicateRowCount,
      filteredOutByCats,
    },
    expandedList,
    {
      skus: productRows.map((r) => r.sku),
      brandNames: brandRows.map((r) => r.name),
      categoryNames: categoryRows.map((r) => r.name),
      hasYugcontractIdColumn: hasYcColumn,
    }
  );

  const totalWallMs = Date.now() - startedAt;

  // ---- 4. print ------------------------------------------------------------
  const out = (s = '') => console.log(s);

  const maxBatchBytes = Math.max(0, ...batchStats.map((b) => b.byteLength));
  const avgBatchMs =
    batchStats.length > 0
      ? Math.round(priceDurationMs / batchStats.length)
      : 0;

  out('== Оцінка Vercel Hobby ==');
  out(`  батчів: ${batchStats.length}; середній час батча: ${avgBatchMs} мс`);
  out(`  найбільша відповідь батча: ${humanBytes(maxBatchBytes)}`);
  out(
    `  пам'ять: сирі рядки відкидаються одразу після нормалізації; тримаємо лише унікальні об'єкти (${report.uniqueProducts})`
  );
  out(
    '  висновок: безпечно для Hobby лише як серія окремих викликів по одному батчу з checkpoint-станом у БД; один запит на весь каталог — ні.'
  );
  out('');

  out('== Приклади товарів (реальні дані фіду, перші 5) ==');
  for (const s of report.samples) {
    out(
      `  [${s.externalId}] ${s.nameUkr} | бренд: ${s.brand ?? '—'} | категорія: ${s.cat ?? '—'} (cat_id=${s.catId ?? '—'}) | ціна: ${fmt(s.price)} грн | RRP: ${fmt(s.rrp)} | qty_main: ${fmt(s.qtyMain)}`
    );
  }
  out('');
  if (report.existingMatchExamples.length > 0) {
    out('Приклади збігів з нашою БД (sku ↔ YC-id проксі):');
    for (const e of report.existingMatchExamples) {
      out(`  sku=${e.sku} ↔ ${e.name}`);
    }
  } else {
    out('Збігів з нашою БД за sku/YC-id проксі не знайдено.');
  }
  out('');

  out('DRY-RUN RESULT');
  out(`всього товарів (рядків фіду): ${report.totalRows}`);
  out(`унікальних товарів: ${report.uniqueProducts}`);
  out(`нових: ${report.newProducts}`);
  out(`вже існуючих Yugcontract ID: ${report.existingInDbBySku}`);
  out(`брендів: ${report.uniqueBrands}`);
  out(`категорій: ${report.observedCategories} (з вибраних представлені: ${report.selectedCategoriesPresent})`);
  out(`з остатком (qty_main > 0): ${report.qtyPositive}`);
  out(`без остатку (qty_main = 0): ${report.qtyZero}`);
  out(`невідомий qty_main: ${report.qtyUnknown}`);
  out(`з ціною: ${report.withPrice}`);
  out(`без ціни: ${report.withoutPrice}`);
  out(`без бренда: ${report.noBrand}`);
  out(`без категорії: ${report.noCategory}`);
  out(`дублікатів: ${report.duplicateRows}`);
  out(`відфільтровано safety-фільтром поза вибіркою: ${report.filteredOutByCats}`);
  out(`діапазон цін: ${fmt(report.minPrice)} – ${fmt(report.maxPrice)} грн (сер. ${fmt(report.avgPrice)})`);
  out(`розмір відповіді (get-price, сумарно): ${humanBytes(totalBytes)}`);
  out(`час отримання даних (get-price): ${(priceDurationMs / 1000).toFixed(1)} с; загальний час скрипта: ${(totalWallMs / 1000).toFixed(1)} с`);
  out('');
  out('DATABASE CHANGES');
  out(
    hasYcColumn
      ? 'products.yugcontract_id: колонка вже існує.'
      : "products.yugcontract_id: міграцію НЕ застосовано (потрібна лише перед реальним імпортом)."
  );
  out('Записів у БД зроблено: 0 (лише SELECT). Змін production-даних: 0.');
}

main().catch((err) => {
  console.error('Помилка dry-run:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
