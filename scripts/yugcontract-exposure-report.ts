/**
 * READ-ONLY exposure report — Yugcontract incident diagnostics 2026-09.
 *
 * Incident: the supplier pulled ~90% of its goods from the warehouse/site.
 * The owner wants to know the scale BEFORE deciding whether to run a sync.
 * The importer never deactivates anything (import-run.ts: no is_active
 * writes; products outside the feed stay frozen), so the open question is
 * exactly: "what WOULD the next sync do to our catalog?" — answered here
 * without running it.
 *
 * Feed strategy: ONE get-price call with `cats: []` (the client-documented
 * "empty array = full catalog") as the ground truth of what the supplier
 * still lists, PLUS a selection-scoped view (approved categories from
 * app/lib/yugcontract/selection.ts expanded over the live tree) that
 * mirrors what the importer would actually request and update. The same
 * mapFeedProducts() skip rules are applied to both views so the numbers
 * match what a sync would process.
 *
 * Incident observations are printed as they affect interpretation:
 * the live get-categories tree may be collapsed (2026-09: 9 nodes left).
 *
 * What it NEVER does: writes to any table, migrations, rpc calls,
 * credential printing. DATABASE CHANGES = none by design. Nothing to
 * roll back on failure — everything is held in memory only.
 *
 * Matching key: products.yugcontract_id (= feed external id), per the
 * project invariant "products: Yugcontract id → products.yugcontract_id,
 * never name/sku". _du rows are alias pairs — excluded from the main
 * numbers and reported as a separate line.
 *
 * Usage: node scripts/yugcontract-exposure-report.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader (KEY=VALUE lines) — same pattern as the other
// scripts; no secrets are printed anywhere below.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

const { getPriceCatalogWithMeta, getCategoriesCatalog } = await import(
  '../app/lib/yugcontract/client.ts'
);
const { extractRawProducts, extractCategoryRows, detectCategoryFields, normalizeCategoryNode } =
  await import('../app/lib/yugcontract/normalize.ts');
const { createClient } = await import('@supabase/supabase-js');
const { SELECTED_CATEGORIES, flattenSelectedIds } = await import(
  '../app/lib/yugcontract/selection.ts'
);
const { makeCategoryFilter } = await import('../app/lib/yugcontract/dry-run.ts');
const { mapFeedProducts } = await import('../app/lib/yugcontract/import-plan.ts');

// PostgREST caps any single response at 1000 rows — PAGE_SIZE must stay <= 1000.
const PAGE_SIZE = 1000;

interface OurProductRow {
  id: string;
  sku: string;
  name: string;
  yugcontract_id: string | null;
  is_active: boolean | null;
  category_id: string | null;
  availability_status: string | null;
  stock_quantity: number | null;
}

interface OurCategoryRow {
  id: string;
  name: string;
  yugcontract_id: string | null;
}

const isDu = (ycId: string): boolean => ycId.endsWith('_du');

async function main(): Promise<void> {
  const startedAt = Date.now();

  // ---- 1. live category tree (interpretation context + selection scope) ---
  console.log('== Крок 1/4: дерево категорій get-categories ==');
  const catParsed = await getCategoriesCatalog();
  const { rows: catRows } = extractCategoryRows(catParsed);
  const catFields = detectCategoryFields(catRows);
  const nodes = catRows.map((row) => normalizeCategoryNode(row, catFields));
  const nodeNameById = new Map(nodes.map((n) => [n.externalId, n.name]));
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === null) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n.externalId);
    else childrenOf.set(n.parentId, [n.externalId]);
  }

  const selectedIds = flattenSelectedIds(SELECTED_CATEGORIES);
  const expanded = new Set<string>();
  const unknownSelected: string[] = [];
  for (const id of selectedIds) {
    if (!nodeNameById.has(id)) {
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
  console.log(
    `  вузлів у дереві постачальника ЗАРАЗ: ${nodes.length}` +
      `; вибрано в затвердженій вибірці: ${selectedIds.length}` +
      `; знайдено в живому дереві (з нащадками): ${expanded.size}` +
      (unknownSelected.length > 0
        ? `; НЕЗНАЙДЕНО в дереві: ${unknownSelected.length} id (зникли разом з Каталогом)`
        : '')
  );
  console.log('  живе дерево зараз:');
  for (const n of nodes) {
    console.log(`    [${n.externalId}] ${n.parentId === null ? '' : '  '}${n.name}`);
  }

  // ---- 2. DB snapshot (SELECT only) ---------------------------------------
  console.log('\n== Крок 2/4: знімок нашої БД (тільки SELECT) ==');
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
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
        .returns<T[]>();
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if ((data ?? []).length < PAGE_SIZE) return rows;
      from += PAGE_SIZE;
    }
  }

  const productRows = await fetchAll<OurProductRow>(
    'products',
    'id,sku,name,yugcontract_id,is_active,category_id,availability_status,stock_quantity'
  );
  const categoryRows = await fetchAll<OurCategoryRow>('categories', 'id,name,yugcontract_id');
  const categoryNameById = new Map(categoryRows.map((c) => [c.id, c.name]));
  const ourCategoryYcIds = new Set(
    categoryRows.flatMap((c) => (c.yugcontract_id !== null ? [c.yugcontract_id] : []))
  );
  console.log(`  products: ${productRows.length}, categories: ${categoryRows.length}`);

  // ---- 3. ONE full-catalog get-price (cats=[] = усе, що лишилось у Юга) ---
  console.log('\n== Крок 3/4: get-price всього каталогу (cats=[], один запит) ==');
  const { parsed, byteLength } = await getPriceCatalogWithMeta({ cats: [] });
  const merger = await import('../app/lib/yugcontract/dry-run.ts').then((m) => {
    const acc = new m.YcProductMerger();
    acc.addRawBatch(extractRawProducts(parsed));
    return acc;
  });
  const fullProducts = merger.values();
  const keepInSelection = makeCategoryFilter(expanded);
  const selectionProducts = fullProducts.filter(keepInSelection);
  console.log(
    `  унікальних товарів у ВСЬОМУ фіді: ${fullProducts.length} (${(byteLength / 1024).toFixed(0)} KiB)` +
      `; з них у межах затвердженої вибірки: ${selectionProducts.length}`
  );

  const fullMap = mapFeedProducts(fullProducts);
  const selMap = mapFeedProducts(selectionProducts);
  const fullMappedById = new Map(fullMap.rows.map((r) => [r.yugcontract_id, r]));
  const selMappedById = new Map(selMap.rows.map((r) => [r.yugcontract_id, r]));
  const fullRawIds = new Set(fullProducts.map((p) => p.externalId));
  const selMappedIds = new Set(selMappedById.keys());
  const ourYcIdsAll = new Set(
    productRows.flatMap((p) => (p.yugcontract_id !== null ? [p.yugcontract_id] : []))
  );

  // ---- 4. classification + printing ---------------------------------------
  console.log('\n== Крок 4/4: класифікація (зіставлення з нашою БД) ==\n');

  const activeBase = productRows.filter(
    (p) => p.is_active === true && p.yugcontract_id !== null && !isDu(p.yugcontract_id)
  );
  const activeDu = productRows.filter(
    (p) => p.is_active === true && p.yugcontract_id !== null && isDu(p.yugcontract_id)
  );
  const activeManual = productRows.filter((p) => p.is_active === true && p.yugcontract_id === null);

  interface Bucket {
    /** in selection scope AND mapped → sync would update the row */
    syncQtyPositive: number;
    syncQtyZero: number;
    /** present in the full feed but OUTSIDE the selection scope → frozen */
    outsideSelection: number;
    /** in selection feed raw rows but dropped by mapFeedProducts skips */
    presentSkipped: number;
    /** absent from the full feed entirely → frozen */
    absent: number;
    /** absent AND currently shown as in_stock — the "phantom availability" set */
    absentInStock: number;
  }
  const emptyBucket = (): Bucket => ({
    syncQtyPositive: 0,
    syncQtyZero: 0,
    outsideSelection: 0,
    presentSkipped: 0,
    absent: 0,
    absentInStock: 0,
  });

  const classify = (p: OurProductRow, b: Bucket): void => {
    const ycId = p.yugcontract_id;
    if (ycId === null) return;
    if (selMappedIds.has(ycId)) {
      const row = selMappedById.get(ycId);
      if (row !== undefined && row.stock_quantity > 0) b.syncQtyPositive += 1;
      else b.syncQtyZero += 1;
    } else if (fullMappedById.has(ycId) || fullRawIds.has(ycId)) {
      b.outsideSelection += 1;
    } else {
      b.absent += 1;
      if ((p.availability_status ?? '') === 'in_stock') b.absentInStock += 1;
    }
  };

  const baseBucket = emptyBucket();
  for (const p of activeBase) classify(p, baseBucket);
  const duBucket = emptyBucket();
  for (const p of activeDu) classify(p, duBucket);

  const totalBase = activeBase.length;
  const presentFull = totalBase - baseBucket.absent;
  // ...presence computed against the FULL feed:
  const inFeedCount = (b: Bucket): number =>
    b.syncQtyPositive + b.syncQtyZero + b.outsideSelection + b.presentSkipped;

  // New products the sync would create (mapped feed rows with no DB row).
  interface NewProductRow {
    ycId: string;
    isDu: boolean;
    catName: string;
    inSelection: boolean;
    categoryResolvable: boolean;
  }
  const newProducts: NewProductRow[] = [];
  for (const r of fullMap.rows) {
    if (ourYcIdsAll.has(r.yugcontract_id)) continue;
    newProducts.push({
      ycId: r.yugcontract_id,
      isDu: isDu(r.yugcontract_id),
      catName:
        (r.catYcId !== null ? nodeNameById.get(r.catYcId) : null) ??
        `(категорія ${r.catYcId ?? '—'} — немає в живому дереві)`,
      inSelection: r.catYcId !== null && expanded.has(r.catYcId),
      categoryResolvable: r.catYcId !== null && ourCategoryYcIds.has(r.catYcId),
    });
  }
  const newBase = newProducts.filter((n) => !n.isDu);
  const newDu = newProducts.filter((n) => n.isDu);
  const newSyncWouldCreate = newProducts.filter((n) => n.inSelection && n.categoryResolvable);
  const topNewCats = [
    ...newBase.reduce(
      (acc, n) => acc.set(n.catName, (acc.get(n.catName) ?? 0) + 1),
      new Map<string, number>()
    ),
  ]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Risk map: our categories by how many of their active base products are
  // absent from the feed (frozen "phantom availability" candidates).
  interface CatRisk {
    name: string;
    total: number;
    absent: number;
    absentInStock: number;
    syncQtyPositive: number;
  }
  const catRisk = new Map<string, CatRisk>();
  for (const p of activeBase) {
    const name =
      (p.category_id !== null ? categoryNameById.get(p.category_id) : null) ?? '(без категорії)';
    const entry =
      catRisk.get(name) ?? { name, total: 0, absent: 0, absentInStock: 0, syncQtyPositive: 0 };
    entry.total += 1;
    const ycId = p.yugcontract_id;
    if (ycId !== null) {
      if (selMappedIds.has(ycId)) {
        const row = selMappedById.get(ycId);
        if (row !== undefined && row.stock_quantity > 0) entry.syncQtyPositive += 1;
      } else if (!fullMappedById.has(ycId) && !fullRawIds.has(ycId)) {
        entry.absent += 1;
        if ((p.availability_status ?? '') === 'in_stock') entry.absentInStock += 1;
      }
    }
    catRisk.set(name, entry);
  }
  const topRiskCats = [...catRisk.values()].sort((a, b) => b.absent - a.absent).slice(0, 10);

  const pct = (n: number, d: number): string =>
    d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;

  const out = (s = '') => console.log(s);

  out('=== ЗВІТ ЕКСПОЗИЦІЇ (read-only діагностика ЧП Yugcontract 2026-09) ===');
  out(`фід (cats=[]): ${fullProducts.length} унікальних товарів у Юга ВСЬОГО (${merger.totalRows} сирих рядків, ${(byteLength / 1024).toFixed(0)} KiB)`);
  out(`мапінг mapFeedProducts: усього пройшло ${fullMap.rows.length}, відкинуто ${fullMap.skipped.length}; у межах вибірки пройшло ${selMap.rows.length}, відкинуто ${selMap.skipped.length}`);
  out('');
  out('--- 1. Наші АКТИВНІ базові товари (yugcontract_id без суфікса _du) ---');
  out(`  всього активних базових: ${totalBase}`);
  out(`  Є у фіді (загалом у Юга): ${presentFull} (${pct(presentFull, totalBase)})`);
  out(`    з них синк ОНОВИВ БИ (у межах вибірки, мапінг пройшов): ${baseBucket.syncQtyPositive + baseBucket.syncQtyZero}`);
  out(`      - qty>0 (лишиться in_stock): ${baseBucket.syncQtyPositive}`);
  out(`      - qty=0 (синк перевів би в out_of_stock): ${baseBucket.syncQtyZero}`);
  out(`    з них У ФІДІ, але поза затвердженою вибіркою (синк не торкнеться): ${baseBucket.outsideSelection}`);
  out(`    з них відкинуто мапінгом у межах вибірки (заморожені як є): ${baseBucket.presentSkipped}`);
  out(`  ВІДСУТНІ у фіді Юга ПОВНІСТЮ (заморожені, синк їх не торкнеться): ${baseBucket.absent} (${pct(baseBucket.absent, totalBase)})`);
  out(`    з них зараз in_stock («фантомна наявність» на сайті): ${baseBucket.absentInStock}`);
  out('');
  out('--- 2. _du-парні товари (аліаси, окремим рядком) ---');
  out(`  всього активних _du: ${activeDu.length}`);
  out(
    `  синк оновив би: ${duBucket.syncQtyPositive + duBucket.syncQtyZero}; поза вибіркою у фіді: ${duBucket.outsideSelection}; ` +
      `відкинуто мапінгом: ${duBucket.presentSkipped}; ВІДСУТНІ у фіді: ${duBucket.absent} (з них in_stock: ${duBucket.absentInStock})`
  );
  out('');
  out('--- 3. Нові товари у фіді, яких у нас немає (синк створив би) ---');
  out(`  нових у ВСЬОМУ фіді: базових ${newBase.length}, _du ${newDu.length}`);
  out(`  з них синк реально створив би (у вибірці + категорія є в нашій БД): ${newSyncWouldCreate.length}`);
  out('  топ-5 категорій нових базових (назви постачальника):');
  if (topNewCats.length === 0) out('    (нових немає)');
  for (const [name, count] of topNewCats) {
    out(`    ${name}: ${count}`);
  }
  out('');
  out('--- 4. Карта ризику: наші категорії за кількістю «зниклих» з фіду активних базових товарів (топ-10) ---');
  out('  категорія | всього активних | відсутні у фіді | частка | з них in_stock (фантом) | синк лишив би qty>0');
  for (const c of topRiskCats) {
    out(
      `    ${c.name} | ${c.total} | ${c.absent} | ${pct(c.absent, c.total)} | ${c.absentInStock} | ${c.syncQtyPositive}`
    );
  }
  const otherAbsent = [...catRisk.values()]
    .sort((a, b) => b.absent - a.absent)
    .slice(10)
    .reduce((sum, c) => sum + c.absent, 0);
  out(`    (решта категорій сумарно: відсутніх ${otherAbsent})`);
  out('');
  out('--- Довідково ---');
  out(`  активних товарів без yugcontract_id (ручні): ${activeManual.length} — синк їх не торкається`);
  out(
    `  підсумок: у фіді Юга лишилось ${inFeedCount(baseBucket)} з ${totalBase} активних базових (${pct(inFeedCount(baseBucket), totalBase)}); ` +
      `повністю зникли ${baseBucket.absent} (${pct(baseBucket.absent, totalBase)}), з них «фантомно» in_stock — ${baseBucket.absentInStock}`
  );
  out('');
  out('Записів у БД зроблено: 0 (лише SELECT). Змін production-даних: 0.');
  out(`Час роботи: ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);
}

main().catch((err) => {
  console.error('Помилка звіту:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
