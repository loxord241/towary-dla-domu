/**
 * Yugcontract category remap toolkit (incident 2026-09: supplier changed
 * category ids). READ-ONLY against the DB in every mode; the only supplier
 * API call is the explicit --fetch-tree (one get-categories, read-only).
 * The actual remap is applied MANUALLY by the owner from the generated
 * apply.sql — there is deliberately NO --apply mode.
 *
 * Pipeline (order matters, artifacts live in logs/remap-<UTC date>/):
 *   1. node scripts/yugcontract-category-remap.ts --snapshot
 *        SELECT-only: categories + junction/product counts ->
 *        our-categories.json + README.md (also the rollback plan).
 *   2. node scripts/yugcontract-category-remap.ts --fetch-tree <out.json>
 *        ONE get-categories call (run AFTER the supplier restored the feed;
 *        sanity: ~524 nodes / 9 roots, not ~9 total). Also viewable via
 *        node scripts/yugcontract-categories-preview.ts (prints only).
 *   3. node scripts/yugcontract-category-remap.ts --map <supplier-tree.json>
 *        matches old yc ids to new ones by FULL normalized name path ->
 *        mapping.json + mapping-report.md. No DB access.
 *   4. node scripts/yugcontract-category-remap.ts --dry-run <mapping.json>
 *        read-only verification (fresh-tree existence, bijection, importer
 *        forecast via buildCategoryPlan) -> apply.sql + selection-draft.json
 *        + Monday checklist. Criterion: "категорії: створити 0".
 *   5. Owner applies apply.sql in the SQL Editor, regenerates selection.ts
 *      from selection-draft.json, then runs `yugcontract-import-run --plan`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader (KEY=VALUE lines) — same pattern as the other
// scripts (scripts/yugcontract-mark-missing-oos.ts); no secrets are printed.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

import type { YcCategoryNode } from '../app/lib/yugcontract/types.ts';
import {
  buildRemapMapping,
  buildApplySql,
  forecastRemap,
  mapSelectionTree,
  verifyBijection,
} from '../app/lib/yugcontract/category-remap.ts';
import type {
  OurCategoryRow,
  RemapMappingEntry,
} from '../app/lib/yugcontract/category-remap.ts';
import { SELECTED_CATEGORIES } from '../app/lib/yugcontract/selection.ts';

const SCRIPT_VERSION = '1.0.0';
const PAGE_SIZE = 1000; // PostgREST response cap — never request more.

interface SnapshotFile {
  kind: 'yugcontract-remap-our-categories';
  script_version: string;
  created_at: string;
  counts: {
    categories_total: number;
    categories_with_yc_id: number;
    categories_manual: number;
    junction_links: number;
    products_total: number;
    products_active: number;
  };
  categories: OurCategoryRow[];
  /** category uuid -> junction (product_categories) link count */
  junction_counts: Record<string, number>;
  /** category uuid -> products.category_id counts */
  products_category_counts: Record<string, { total: number; active: number }>;
}

interface SupplierTreeFile {
  kind: 'yugcontract-remap-supplier-tree';
  script_version: string;
  fetched_at: string;
  source: string;
  stats: Record<string, unknown>;
  nodes: { externalId: string; parentId: string | null; name: string; levelHint: number | null }[];
}

interface MappingFile {
  kind: 'yugcontract-remap-mapping';
  script_version: string;
  created_at: string;
  tree_file: string;
  summary: Record<string, number>;
  mappings: RemapMappingEntry[];
  unmatched: { old_yc_id: string; db_category_id: string; name: string; path: string }[];
  ambiguous: { path: string; candidate_new_ids: string[]; old_yc_ids: string[] }[];
  conflicts: { path: string; new_yc_id: string; old_yc_ids: string[] }[];
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function defaultDir(): string {
  const utcDate = new Date().toISOString().slice(0, 10);
  return path.join(root, 'logs', `remap-${utcDate}`);
}

function resolveDir(flag?: string): string {
  const dir = flag ? (path.isAbsolute(flag) ? flag : path.join(root, flag)) : defaultDir();
  return dir;
}

function resolveInput(file: string): string {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

async function createDbClient() {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
}

/** Paged read-only select (PAGE_SIZE windows, explicit .order tiebreaker). */
interface QueryResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

async function fetchAll<T>(
  makeQuery: (from: number, limit: number) => PromiseLike<QueryResult<T>>
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery(from, PAGE_SIZE);
    if (error) throw new Error(`select failed: ${error.message}`);
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

function readJson<T extends { kind?: string }>(file: string, expectedKind: string): T {
  if (!existsSync(file)) throw new Error(`Файл не знайдено: ${file}`);
  const json = JSON.parse(readFileSync(file, 'utf8')) as T;
  if (json.kind !== expectedKind) {
    throw new Error(`${file} не є ${expectedKind} (kind=${String(json.kind)})`);
  }
  return json;
}

// ---------------------------------------------------------------------------
// mode 1: --snapshot  (DB: SELECT only)
// ---------------------------------------------------------------------------

async function cmdSnapshot(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const db = await createDbClient();

  console.log('== Знімок категорій (лише SELECT) ==');
  const categories = await fetchAll<OurCategoryRow>((from, limit) =>
    db
      .from('categories')
      .select('id,yugcontract_id,name,slug,parent_id')
      .order('id', { ascending: true })
      .range(from, from + limit - 1)
      .returns<OurCategoryRow[]>()
  );

  const junctionRows = await fetchAll<{ category_id: string | null }>((from, limit) =>
    db
      .from('product_categories')
      .select('category_id')
      .order('category_id', { ascending: true })
      .range(from, from + limit - 1)
      .returns<{ category_id: string | null }[]>()
  );

  const productRows = await fetchAll<{ category_id: string | null; is_active: boolean | null }>((from, limit) =>
    db
      .from('products')
      .select('category_id,is_active')
      .order('id', { ascending: true })
      .range(from, from + limit - 1)
      .returns<{ category_id: string | null; is_active: boolean | null }[]>()
  );

  const junctionCounts: Record<string, number> = {};
  for (const r of junctionRows) {
    if (r.category_id === null) continue;
    junctionCounts[r.category_id] = (junctionCounts[r.category_id] ?? 0) + 1;
  }
  const productCounts: Record<string, { total: number; active: number }> = {};
  let productsActive = 0;
  for (const r of productRows) {
    if (r.is_active) productsActive += 1;
    if (r.category_id === null) continue;
    const entry = productCounts[r.category_id] ?? { total: 0, active: 0 };
    entry.total += 1;
    if (r.is_active) entry.active += 1;
    productCounts[r.category_id] = entry;
  }

  const withYc = categories.filter((c) => c.yugcontract_id !== null);
  const payload: SnapshotFile = {
    kind: 'yugcontract-remap-our-categories',
    script_version: SCRIPT_VERSION,
    created_at: new Date().toISOString(),
    counts: {
      categories_total: categories.length,
      categories_with_yc_id: withYc.length,
      categories_manual: categories.length - withYc.length,
      junction_links: junctionRows.length,
      products_total: productRows.length,
      products_active: productsActive,
    },
    categories: [...categories].sort((a, b) => (a.yugcontract_id ?? '').localeCompare(b.yugcontract_id ?? '')),
    junction_counts: junctionCounts,
    products_category_counts: productCounts,
  };
  const outFile = path.join(dir, 'our-categories.json');
  writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  writeFileSync(path.join(dir, 'README.md'), readmeText(dir), 'utf8');

  console.log(`  categories: ${categories.length} (з yugcontract_id: ${withYc.length}, manual: ${categories.length - withYc.length})`);
  console.log(`  product_categories (junction): ${junctionRows.length} посилань`);
  console.log(`  products: ${productRows.length} (активних ${productsActive})`);
  console.log(`  знято: ${outFile}`);
  console.log(`  інструкція/план відкату: ${path.join(dir, 'README.md')}`);
}

function readmeText(dir: string): string {
  const rel = (f: string): string => path.relative(root, path.join(dir, f));
  return `# Yugcontract category remap — знімок ${new Date().toISOString()}

Поставщик змінив id категорій (інцидент 2026-09). Ця папка — арбітражний
знімок стану ДО ремапу та інструкція пайплайна. Скрипт у всіх режимах
read-only щодо БД; застосування — ВРУЧНУ через apply.sql.

## Пайплайн (по порядку)

1. **Знімок** (цей крок): \`node scripts/yugcontract-category-remap.ts --snapshot\`
   → \`our-categories.json\` (усі рядки categories + кількості товарів).

2. **Свіже дерево поставщика** — ПІСЛЯ відновлення фіду:
   \`\`\`bash
   node scripts/yugcontract-category-remap.ts --fetch-tree ${rel('supplier-tree.json')}
   \`\`\`
   Це ОДИН read-only виклик get-categories, результат нормалізовано у JSON.
   Для візуальної звірки: \`node scripts/yugcontract-categories-preview.ts\`
   (друкує дерево/статистику у stdout, файлів не пише; прапорців не має).
   Санітарний критерій готовності: total ≈ 524 вузли / 9 коренів
   (L0:9 L1:59 L2:252 L3:204 станом на 2026-08). Якщо total ≈ 9 — фід ще
   колапсований, ЧЕКАТИ.

3. **Мапінг** (без БД):
   \`\`\`bash
   node scripts/yugcontract-category-remap.ts --map ${rel('supplier-tree.json')}
   \`\`\`
   Матч ЛИШЕ за ПОВНИМ шляхом імен (нормалізованим). Результат:
   \`mapping.json\` + \`mapping-report.md\` (matched/unmatched/ambiguous).

4. **Верифікація** (read-only):
   \`\`\`bash
   node scripts/yugcontract-category-remap.ts --dry-run ${rel('mapping.json')}
   \`\`\`
   Перевіряє: кожен новий id існує у свіжому дереві; бієкція; прогноз
   buildCategoryPlan після ремапу. Генерує \`apply.sql\` +
   \`selection-draft.json\`.

5. **Ручне застосування** (власник):
   - Supabase SQL Editor → вміст \`apply.sql\` (одна транзакція, кожен
     UPDATE захищений старим значенням yugcontract_id);
   - оновити \`app/lib/yugcontract/selection.ts\` з \`selection-draft.json\`
     (id → нові, структура/назви збережені);
   - \`node scripts/yugcontract-import-run.ts --plan\` → критерій
     **«категорії: створити 0»**. Не 0 → НЕ запускати --run, розбиратись.

## План відкату

\`our-categories.json\` — повний стан categories ДО ремапу. Відкат: у
\`apply.sql\` поміняти місцями SET і WHERE значення (SET old, WHERE new)
— кожен рядок містить пару в коментарі. Або SQL:

\`\`\`sql
UPDATE categories c SET yugcontract_id = s.old_yc_id
FROM (VALUES ('<new>', '<old>'), ...) AS s(new_yc_id, old_yc_id)
WHERE c.yugcontract_id = s.new_yc_id;
\`\`\`

## Файли

- \`our-categories.json\` — знімок (вид відкату);
- \`README.md\` — цей файл;
- \`supplier-tree.json\` — свіже дерево поставщика (крок 2);
- \`mapping.json\` / \`mapping-report.md\` — мапінг (крок 3);
- \`apply.sql\`, \`selection-draft.json\` — верифіковані артефакти (крок 4).
`;
}

// ---------------------------------------------------------------------------
// mode 2: --fetch-tree <out.json>  (ONE supplier get-categories call)
// ---------------------------------------------------------------------------

async function cmdFetchTree(outFile: string): Promise<void> {
  const { getCategoriesCatalog } = await import('../app/lib/yugcontract/client.ts');
  const { extractCategoryRows, detectCategoryFields, normalizeCategoryNode, buildCategoryTree } =
    await import('../app/lib/yugcontract/normalize.ts');

  console.log('== Свіже дерево get-categories (один read-only виклик) ==');
  const parsed = await getCategoriesCatalog();
  const { rows, arrayPath } = extractCategoryRows(parsed);
  const fields = detectCategoryFields(rows);
  const nodes = rows.map((row) => normalizeCategoryNode(row, fields));
  const { stats } = buildCategoryTree(nodes as YcCategoryNode[]);

  const payload: SupplierTreeFile = {
    kind: 'yugcontract-remap-supplier-tree',
    script_version: SCRIPT_VERSION,
    fetched_at: new Date().toISOString(),
    source: 'get-categories via app/lib/yugcontract/client.ts',
    stats: { ...stats, arrayPath, fields },
    nodes: nodes.map((n) => ({
      externalId: n.externalId,
      parentId: n.parentId,
      name: n.name,
      levelHint: n.levelHint,
    })),
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`  arrayPath: ${arrayPath}; fields: id=${fields.id} name=${fields.name} parent=${fields.parent}`);
  console.log(`  total=${stats.totalNodes} roots=${stats.rootCount} maxDepth=${stats.maxDepth} orphans=${stats.orphanCount}`);
  const levels = Object.entries(stats.levelCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([l, c]) => `L${l}:${c}`)
    .join(' ');
  console.log(`  levels: ${levels}`);
  if (stats.totalNodes < 50) {
    console.error(
      '\nУВАГА: вузлів менше 50 — фід, схоже, ще колапсований (інцидент 2026-09). ' +
        'Мапінг по такому дереву робити НЕ можна: дочекайтесь відновлення.'
    );
    process.exitCode = 2;
    return;
  }
  console.log(`  збережено: ${outFile}`);
}

// ---------------------------------------------------------------------------
// tree-file parsing shared by --map / --dry-run
// ---------------------------------------------------------------------------

/** Accepts our canonical SupplierTreeFile OR a raw get-categories response. */
async function loadSupplierNodes(file: string): Promise<{ nodes: YcCategoryNode[]; source: string }> {
  const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (
    json &&
    typeof json === 'object' &&
    (json as { kind?: string }).kind === 'yugcontract-remap-supplier-tree'
  ) {
    const tree = json as SupplierTreeFile;
    return {
      nodes: tree.nodes.map((n) => ({
        externalId: n.externalId,
        parentId: n.parentId,
        name: n.name,
        levelHint: n.levelHint,
      })),
      source: path.basename(file),
    };
  }
  // Raw API response: reuse the production normalizers (pure).
  const { extractCategoryRows, detectCategoryFields, normalizeCategoryNode } = await import(
    '../app/lib/yugcontract/normalize.ts'
  );
  const { rows } = extractCategoryRows(json);
  const fields = detectCategoryFields(rows);
  return {
    nodes: rows.map((row) => normalizeCategoryNode(row, fields)),
    source: `${path.basename(file)} (raw get-categories)`,
  };
}

// ---------------------------------------------------------------------------
// mode 3: --map <supplier-tree.json>  (no DB access)
// ---------------------------------------------------------------------------

async function cmdMap(treeFile: string, dir: string): Promise<void> {
  const { nodes, source } = await loadSupplierNodes(resolveInput(treeFile));
  const snapPath = path.join(dir, 'our-categories.json');
  const snap = readJson<SnapshotFile>(snapPath, 'yugcontract-remap-our-categories');

  console.log(`== Мапінг: дерево ${source} (${nodes.length} вузлів) × знімок (${snap.categories.length} рядків) ==`);
  console.log('   матч — ЛИШЕ за повним нормалізованим шляхом імен; ніяких записів у БД.');

  const result = buildRemapMapping(nodes, snap.categories);
  const unchanged = result.mappings.filter((m) => m.unchanged).length;
  const summary = {
    our_rows: snap.categories.length,
    with_yc_id: snap.counts.categories_with_yc_id,
    matched: result.mappings.length,
    unchanged,
    unmatched: result.unmatched.length,
    ambiguous: result.ambiguous.length,
    conflicts: result.conflicts.length,
  };

  const payload: MappingFile = {
    kind: 'yugcontract-remap-mapping',
    script_version: SCRIPT_VERSION,
    created_at: new Date().toISOString(),
    tree_file: path.basename(resolveInput(treeFile)),
    summary,
    mappings: [...result.mappings].sort((a, b) => a.old_yc_id.localeCompare(b.old_yc_id, undefined, { numeric: true })),
    unmatched: result.unmatched,
    ambiguous: result.ambiguous,
    conflicts: result.conflicts,
  };
  const outFile = path.join(dir, 'mapping.json');
  writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  writeFileSync(path.join(dir, 'mapping-report.md'), mappingReportMd(payload, snap), 'utf8');

  console.log(`  matched: ${summary.matched} / ${summary.with_yc_id} (без зміни id: ${unchanged})`);
  console.log(`  unmatched: ${summary.unmatched}; ambiguous: ${summary.ambiguous}; conflicts: ${summary.conflicts}`);
  console.log(`  збережено: ${outFile}`);
  console.log(`  звіт: ${path.join(dir, 'mapping-report.md')}`);
  if (summary.matched === 0) {
    console.error('\nЖОДНОГО збігу — дерево, найімовірніше, ще колапсоване або знімок не з тих дат. Мапінг НЕ записано як валідний (перевір kind/дати).');
    process.exitCode = 2;
  }
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function mappingReportMd(map: MappingFile, snap: SnapshotFile): string {
  const productsByUuid = (uuid: string): number => snap.products_category_counts[uuid]?.total ?? 0;
  const lines: string[] = [
    `# Remap report`,
    '',
    `- created: ${map.created_at}`,
    `- дерево: ${map.tree_file}`,
    `- рядків categories у знімку: ${map.summary.our_rows} (з yugcontract_id: ${map.summary.with_yc_id})`,
    `- **matched: ${map.summary.matched}** (id без змін: ${map.summary.unchanged})`,
    `- unmatched: ${map.summary.unmatched}; ambiguous: ${map.summary.ambiguous}; conflicts: ${map.summary.conflicts}`,
    '',
    '## Matched (old → new)',
    '',
    '| old yc id | new yc id | наша категорія (uuid) | назва | товарів | шлях |',
    '|---|---|---|---|---|---|',
  ];
  for (const m of map.mappings) {
    lines.push(
      `| ${m.old_yc_id} | ${m.new_yc_id}${m.unchanged ? ' (=)' : ''} | \`${m.db_category_id}\` | ${esc(m.name)} | ${productsByUuid(m.db_category_id)} | ${esc(m.path)} |`
    );
  }
  if (map.unmatched.length > 0) {
    lines.push(
      '',
      '## Unmatched — пари немає (рішення власника)',
      '',
      '| old yc id | наша категорія (uuid) | назва | товарів | шлях |',
      '|---|---|---|---|---|'
    );
    for (const u of map.unmatched) {
      lines.push(`| ${u.old_yc_id} | \`${u.db_category_id}\` | ${esc(u.name)} | ${productsByUuid(u.db_category_id)} | ${esc(u.path)} |`);
    }
  }
  if (map.ambiguous.length > 0) {
    lines.push(
      '',
      '## Ambiguous — той самий шлях у свіжому дереві трапляється кілька разів',
      ''
    );
    for (const a of map.ambiguous) {
      lines.push(`- \`${a.path}\` → кандидати [${a.candidate_new_ids.join(', ')}]; наші id: ${a.old_yc_ids.join(', ')}`);
    }
  }
  if (map.conflicts.length > 0) {
    lines.push(
      '',
      '## Conflicts — кілька НАШИХ категорій з одним шляхом (бієкція порушена, не записано)',
      ''
    );
    for (const c of map.conflicts) {
      lines.push(`- \`${c.path}\` → новий ${c.new_yc_id}; наші старі id: ${c.old_yc_ids.join(', ')}`);
    }
  }
  lines.push(
    '',
    'Наступний крок: `node scripts/yugcontract-category-remap.ts --dry-run logs/remap-*/mapping.json`',
    ''
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// mode 4: --dry-run <mapping.json>  (read-only verification + artifacts)
// ---------------------------------------------------------------------------

async function cmdDryRun(mappingFile: string, treeFile: string | null, dir: string): Promise<void> {
  const mapping = readJson<MappingFile>(resolveInput(mappingFile), 'yugcontract-remap-mapping');
  const snap = readJson<SnapshotFile>(path.join(dir, 'our-categories.json'), 'yugcontract-remap-our-categories');
  const treePath = treeFile ? resolveInput(treeFile) : path.join(dir, mapping.tree_file);
  const { nodes, source } = await loadSupplierNodes(treePath);

  console.log(`== Dry-run верифікація: mapping (${mapping.mappings.length}) × дерево ${source} (${nodes.length} вузлів) ==`);
  let failures = 0;

  // (а) кожен new_yc_id існує у свіжому дереві
  const treeIds = new Set(nodes.map((n) => n.externalId));
  const unknownNew = mapping.mappings.filter((m) => !treeIds.has(m.new_yc_id));
  console.log(`  (а) нові id у свіжому дереві: ${mapping.mappings.length - unknownNew.length}/${mapping.mappings.length}`);
  if (unknownNew.length > 0) {
    failures += unknownNew.length;
    for (const m of unknownNew.slice(0, 20)) {
      console.error(`    ✗ новий id ${m.new_yc_id} (${m.name}) НЕ існує у свіжому дереві`);
    }
  }

  // (б) бієкція
  const bijectionErrors = verifyBijection(mapping.mappings);
  console.log(`  (б) бієкція: ${bijectionErrors.length === 0 ? 'OK (кожен старий → рівно один новий і навпаки)' : 'ПОРУШЕНА'}`);
  for (const e of bijectionErrors) {
    failures += 1;
    console.error(`    ✗ ${e}`);
  }

  // (в) прогноз імпортера: buildCategoryPlan ПІСЛЯ ремапу
  const oldToNew = new Map(mapping.mappings.map((m) => [m.old_yc_id, m.new_yc_id] as const));
  const productsByOldYcId = new Map<string, number>();
  for (const row of snap.categories) {
    if (row.yugcontract_id === null) continue;
    productsByOldYcId.set(row.yugcontract_id, snap.products_category_counts[row.id]?.total ?? 0);
  }
  const forecast = forecastRemap(nodes, snap.categories, mapping.mappings, productsByOldYcId);
  console.log(
    `  (в) прогноз buildCategoryPlan після ремапу: створити ${forecast.plan.creates.length}, оновити ${forecast.plan.updates.length}, конфліктів ${forecast.plan.conflicts.length} (expanded ${forecast.expandedCount})`
  );
  if (forecast.plan.creates.length > 0) {
    failures += forecast.plan.creates.length;
    console.error('    ✗ при прогоні --plan будуть СТВОРЕННЯ категорій — ремап неповний:');
    for (const c of forecast.createsPreview) console.error(`      ${c.yugcontract_id} ${c.name}`);
  }
  if (forecast.plan.conflicts.length > 0) {
    failures += forecast.plan.conflicts.length;
    for (const c of forecast.plan.conflicts) console.error(`    ✗ конфлікт: ${c}`);
  }
  const unmatchedWithProducts = forecast.unmatchedWithProducts.filter((u) => u.products > 0);
  if (unmatchedWithProducts.length > 0) {
    console.log(
      `  ! unmatched з товарами: ${unmatchedWithProducts.length} (сумарно ${unmatchedWithProducts.reduce((s, u) => s + u.products, 0)} товарів) — рішення власника`
    );
  }

  if (failures > 0) {
    console.error(`\nСТОП: ${failures} проблем(и). apply.sql НЕ згенеровано — виправте мапінг (перегоніть --map на свіжому дереві) і повторіть.`);
    process.exitCode = 2;
    return;
  }

  // Артефакти: apply.sql + selection-draft.json + чек-лист
  const generatedAt = new Date().toISOString();
  const applySql = buildApplySql(mapping.mappings, generatedAt);
  writeFileSync(path.join(dir, 'apply.sql'), applySql, 'utf8');

  const draft = mapSelectionTree(SELECTED_CATEGORIES, oldToNew);
  const draftPayload = {
    kind: 'yugcontract-remap-selection-draft',
    script_version: SCRIPT_VERSION,
    generated_at: generatedAt,
    note: 'Заміна для SELECTED_CATEGORIES у app/lib/yugcontract/selection.ts (id → нові; структура/назві збережені). Незмаплені id залишені старими — їх видно імпортеру як unknown.',
    unresolved_old_ids: draft.unresolvedOldIds,
    tree: draft.tree,
  };
  writeFileSync(
    path.join(dir, 'selection-draft.json'),
    JSON.stringify(draftPayload, null, 2),
    'utf8'
  );

  console.log('\n  згенеровано:');
  console.log(`    ${path.join(dir, 'apply.sql')} (${mapping.mappings.length} UPDATE у одній транзакції)`);
  console.log(`    ${path.join(dir, 'selection-draft.json')} (незмаплених у selection: ${draft.unresolvedOldIds.length})`);

  console.log('\n== Чек-лист понеділка ==');
  console.log('  1. (власник) Supabase SQL Editor → виконати apply.sql; контроль:');
  console.log('     SELECT count(*) FROM categories WHERE yugcontract_id IS NOT NULL;  -- очікується ' + mapping.mappings.length);
  console.log('  2. оновити SELECTED_CATEGORIES у app/lib/yugcontract/selection.ts зі selection-draft.json;');
  console.log('  3. node scripts/yugcontract-import-run.ts --plan  → КРИТЕРІЙ: «категорії: створити 0»');
  console.log('     (не 0 → СТОП, --run не запускати; див. docs/wsl-sync.md розділ «Поведение после…» / інцидент 2026-09);');
  console.log('  4. лише після п.3: bash scripts/wsl/yugcontract-sync.sh (штатний sync трьох фаз);');
  console.log('  5. пост-перевірка: node scripts/catalog-health-check.ts (read-only).');
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlagIdx = args.indexOf('--dir');
  const dirFlag = dirFlagIdx !== -1 ? args[dirFlagIdx + 1] : undefined;

  if (args.includes('--snapshot')) {
    await cmdSnapshot(resolveDir(dirFlag));
    return;
  }
  const fetchIdx = args.indexOf('--fetch-tree');
  if (fetchIdx !== -1) {
    const out = args[fetchIdx + 1];
    if (!out) throw new Error('Вкажіть шлях: --fetch-tree logs/remap-<date>/supplier-tree.json');
    await cmdFetchTree(resolveInput(out));
    return;
  }
  const mapIdx = args.indexOf('--map');
  if (mapIdx !== -1) {
    const tree = args[mapIdx + 1];
    if (!tree) throw new Error('Вкажіть файл дерева: --map logs/remap-<date>/supplier-tree.json');
    await cmdMap(tree, resolveDir(dirFlag));
    return;
  }
  const dryIdx = args.indexOf('--dry-run');
  if (dryIdx !== -1) {
    const mapping = args[dryIdx + 1];
    if (!mapping) throw new Error('Вкажіть файл мапінгу: --dry-run logs/remap-<date>/mapping.json');
    const mappingAbs = resolveInput(mapping);
    const mappingDir = path.dirname(mappingAbs);
    const treeIdx = args.indexOf('--tree');
    const tree = treeIdx !== -1 ? args[treeIdx + 1] ?? null : null;
    await cmdDryRun(mappingAbs, tree, dirFlag ? resolveDir(dirFlag) : mappingDir);
    return;
  }

  console.error(
    'Використання:\n' +
      '  node scripts/yugcontract-category-remap.ts --snapshot [--dir logs/remap-<date>]\n' +
      '  node scripts/yugcontract-category-remap.ts --fetch-tree logs/remap-<date>/supplier-tree.json\n' +
      '  node scripts/yugcontract-category-remap.ts --map logs/remap-<date>/supplier-tree.json [--dir logs/remap-<date>]\n' +
      '  node scripts/yugcontract-category-remap.ts --dry-run logs/remap-<date>/mapping.json [--tree supplier-tree.json]\n' +
      '\nРежими --snapshot/--map/--dry-run read-only щодо БД; --fetch-tree робить один read-only виклик get-categories.'
  );
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error('Помилка:', err instanceof Error ? err.message : err);
  process.exit(2);
});
