/**
 * ONE-SHOT incident action (Yugcontract feed collapse 2026-09, owner-approved).
 *
 * The supplier feed collapsed (~326 goods, 9 categories, category ids
 * changed): only a fraction of our active catalog is still listed by the
 * supplier, while thousands of our products keep showing "in_stock" —
 * phantom availability. The importer never deactivates anything and the
 * next sync would only fix products still present in the feed (qty=0
 * rows), so the owner APPROVED a one-time manual action: mark every
 * active product that is ABSENT from the live feed AND currently
 * in_stock as out_of_stock (stock_quantity = 0).
 *
 * WRITE SCOPE (hard, owner-authorized):
 *   - products.availability_status -> 'out_of_stock'
 *   - products.stock_quantity      -> 0
 *   - ONLY for rows with is_active = true, yugcontract_id NOT NULL,
 *     absent from the fresh full feed (matched by yugcontract_id =
 *     feed external id) and availability_status = 'in_stock' right now.
 *   - _du alias rows are included; manual rows (yugcontract_id = null)
 *     are untouched by construction; feed rows with qty = 0 are NOT
 *     touched here (the regular sync owns them).
 *   - Nothing else: no is_active, prices, names, categories, orders,
 *     staging tables, yc_import_batches, rpc, migrations, schema.
 *
 * Feed strategy mirrors scripts/yugcontract-exposure-report.ts: ONE
 * get-price call with cats: [] (full catalog) is the ground truth of
 * what the supplier still lists; rows are merged via YcProductMerger
 * and re-mapped through mapFeedProducts() so the counts stay comparable
 * with the diagnostics.
 *
 * Safety rails:
 *   - order is strictly: feed -> DB read -> deviation gate -> snapshot
 *     file -> chunked writes; ANY failure before the write stage aborts
 *     with zero writes;
 *   - deviation gate: found targets must be within TOLERANCE of the
 *     diagnostics expectation (4632 base + 141 _du) — a bigger drift
 *     means the feed moved again => STOP, write nothing, report;
 *   - snapshot logs/oos-batch-<UTC date>.json is written BEFORE the
 *     first update and is the ONLY rollback artifact (--revert);
 *   - writes are chunked (200 ids per update, .in(...)) and idempotent:
 *     a re-run recomputes targets from the fresh DB state and only
 *     finishes the remainder. On re-run the snapshot file is MERGED
 *     (first recorded old state wins) so the full rollback list is
 *     never lost;
 *   - post-write verification (read-only) re-checks that no target is
 *     left in_stock and reports the active-catalog OOS share before/after.
 *
 * Usage:
 *   node scripts/yugcontract-mark-missing-oos.ts --apply
 *   node scripts/yugcontract-mark-missing-oos.ts --revert --snapshot logs/oos-batch-2026-09-05.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader (KEY=VALUE lines) — same pattern as the other
// scripts (scripts/catalog-health-check.ts:50-55); no secrets are printed.
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

const SCRIPT_VERSION = '1.0.0';
const PAGE_SIZE = 1000; // PostgREST response cap — never request more.
const CHUNK = 200; // update batch size per the action spec

// Expectation from scripts/yugcontract-exposure-report.ts (2026-09 run):
// active products absent from the feed AND currently in_stock.
const EXPECTED_BASE = 4632;
const EXPECTED_DU = 141;
/** Relative drift vs the expectation that still counts as "feed is alive". */
const TOLERANCE = 0.05;

const isDu = (ycId: string): boolean => ycId.endsWith('_du');

interface SnapshotTarget {
  id: string;
  yugcontract_id: string;
  slug: string;
  old_availability_status: string;
  old_stock_quantity: number | null;
}

interface SnapshotFile {
  kind: 'yugcontract-mark-missing-oos-snapshot';
  script_version: string;
  created_at: string;
  expected: { base: number; du: number };
  target_count: number;
  targets: SnapshotTarget[];
}

interface ProductRow {
  id: string;
  yugcontract_id: string | null;
  slug: string;
  availability_status: string | null;
  stock_quantity: number | null;
}

async function createDbClient() {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
}

/** Paged read-only select; returns all rows of a table/query. */
async function fetchAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeQuery: (from: number, limit: number) => any
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery(from, PAGE_SIZE);
    if (error) throw new Error(`select failed: ${error.message}`);
    const chunk = (data ?? []) as Record<string, unknown>[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) return rows;
    from += PAGE_SIZE;
  }
}

/** Fresh full feed (ONE get-price call, cats=[] = усе, що лишилось у Юга). */
async function loadFeedIds(): Promise<{ feedIds: Set<string>; unique: number; mapped: number; skipped: number }> {
  const { getPriceCatalogWithMeta } = await import('../app/lib/yugcontract/client.ts');
  const { extractRawProducts } = await import('../app/lib/yugcontract/normalize.ts');
  const { YcProductMerger } = await import('../app/lib/yugcontract/dry-run.ts');
  const { mapFeedProducts } = await import('../app/lib/yugcontract/import-plan.ts');

  const { parsed, byteLength } = await getPriceCatalogWithMeta({ cats: [] });
  const merger = new YcProductMerger();
  merger.addRawBatch(extractRawProducts(parsed));
  const products = merger.values();

  const mapped = mapFeedProducts(products);
  // Ground truth of "present in the feed" = the merged raw external ids
  // (same definition as the exposure report's `fullRawIds`), so products
  // the mapper skips are still considered present and stay untouched.
  const feedIds = new Set(products.map((p) => p.externalId));
  for (const row of mapped.rows) feedIds.add(row.yugcontract_id);

  console.log(
    `Фід: ${merger.totalRows} сирих рядків, ${products.length} унікальних, ` +
      `${mapped.rows.length} пройшло мапінг, ${mapped.skipped.length} відкинуто, ` +
      `${(byteLength / 1024).toFixed(0)} KiB`
  );
  return {
    feedIds,
    unique: products.length,
    mapped: mapped.rows.length,
    skipped: mapped.skipped.length,
  };
}

function snapshotPathForToday(): string {
  const utcDate = new Date().toISOString().slice(0, 10);
  return path.join(root, 'logs', `oos-batch-${utcDate}.json`);
}

/**
 * Write (or merge into) the rollback snapshot. On a re-run an existing
 * snapshot is merged with "first recorded old state wins" so the full
 * rollback list survives idempotent continuations.
 */
function writeSnapshot(targets: SnapshotTarget[], filePath: string): void {
  const merged = new Map<string, SnapshotTarget>();
  if (existsSync(filePath)) {
    const prev = JSON.parse(readFileSync(filePath, 'utf8')) as SnapshotFile;
    if (prev.kind !== 'yugcontract-mark-missing-oos-snapshot' || !Array.isArray(prev.targets)) {
      throw new Error(`Файл ${filePath} не є знімком цього скрипта — не перезаписую`);
    }
    for (const t of prev.targets) merged.set(t.id, t);
  }
  for (const t of targets) {
    if (!merged.has(t.id)) merged.set(t.id, t);
  }
  const finalTargets = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  const payload: SnapshotFile = {
    kind: 'yugcontract-mark-missing-oos-snapshot',
    script_version: SCRIPT_VERSION,
    created_at: new Date().toISOString(),
    expected: { base: EXPECTED_BASE, du: EXPECTED_DU },
    target_count: finalTargets.length,
    targets: finalTargets,
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function applyMode(): Promise<void> {
  const db = await createDbClient();

  // ---- 1. fresh feed (fail => no writes) ----------------------------------
  console.log('== Крок 1/4: свіжий фід Юга (get-price, cats=[], read-only) ==');
  const feed = await loadFeedIds();

  // ---- 2. our active products (SELECT only) -------------------------------
  console.log('\n== Крок 2/4: наші активні товари (тільки SELECT) ==');
  const rows = (await fetchAll((from, limit) =>
    db
      .from('products')
      .select('id, yugcontract_id, slug, availability_status, stock_quantity')
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, from + limit - 1)
  )) as unknown as ProductRow[];
  const activeTotal = rows.length;
  const activeYc = rows.filter((p) => p.yugcontract_id !== null);
  const oosBefore = rows.filter((p) => p.availability_status === 'out_of_stock').length;
  console.log(`  активних товарів: ${activeTotal}, з yugcontract_id: ${activeYc.length}, out_of_stock зараз: ${oosBefore}`);

  // ---- 3. targets + deviation gate ----------------------------------------
  console.log('\n== Крок 3/4: цілі (відсутні у фіді + зараз in_stock) ==');
  const targets = activeYc.filter(
    (p) =>
      p.yugcontract_id !== null &&
      !feed.feedIds.has(p.yugcontract_id) &&
      p.availability_status === 'in_stock'
  );
  const targetBase = targets.filter((t) => !isDu(t.yugcontract_id!)).length;
  const targetDu = targets.length - targetBase;
  console.log(`  знайдено цілей: ${targets.length} (базових ${targetBase}, _du ${targetDu})`);
  console.log(`  не чіпаю: у фіді ${activeYc.length - activeYc.filter((p) => !feed.feedIds.has(p.yugcontract_id!)).length};` +
    ` manual (yugcontract_id=null): ${activeTotal - activeYc.length};` +
    ` вже out_of_stock: ${activeYc.filter((p) => p.availability_status === 'out_of_stock').length}`);

  // Already-done guard BEFORE the deviation gate: after a successful run
  // (or a previous fully-applied state) there are legitimately zero
  // targets — that is idempotent success, not a feed drift.
  if (targets.length === 0) {
    console.log('  Цілей немає — усе вже виконано (ідемпотентний повторний запуск), запис не потрібен.');
    return;
  }

  const devBase = Math.abs(targetBase - EXPECTED_BASE) / EXPECTED_BASE;
  const devDu = Math.abs(targetDu - EXPECTED_DU) / EXPECTED_DU;
  const devTotal = Math.abs(targets.length - (EXPECTED_BASE + EXPECTED_DU)) / (EXPECTED_BASE + EXPECTED_DU);
  if (devBase > TOLERANCE || devDu > TOLERANCE || devTotal > TOLERANCE) {
    console.error(
      `\nСТОП: розбіжність з діагностикою перевищує ${(TOLERANCE * 100).toFixed(1)}%.\n` +
        `  очікування (exposure-report): базових ${EXPECTED_BASE}, _du ${EXPECTED_DU}\n` +
        `  факт зараз: базових ${targetBase} (${(devBase * 100).toFixed(1)}%), _du ${targetDu} (${(devDu * 100).toFixed(1)}%)\n` +
        `  НІЧОГО НЕ ЗАПИСАНО. Фід, схоже, знову змінився — спершу прогоніть scripts/yugcontract-exposure-report.ts.`
    );
    process.exit(2);
  }

  // ---- 4. snapshot BEFORE any write ---------------------------------------
  const snapshotPath = snapshotPathForToday();
  writeSnapshot(
    targets.map((t) => ({
      id: t.id,
      yugcontract_id: t.yugcontract_id!,
      slug: t.slug,
      old_availability_status: t.availability_status ?? '',
      old_stock_quantity: t.stock_quantity,
    })),
    snapshotPath
  );
  console.log(`\nЗнімок для відкату: ${snapshotPath}`);

  // ---- 5. chunked writes (ONLY availability_status + stock_quantity) ------
  console.log(`\n== Крок 4/4: запис (чанки по ${CHUNK}, лише availability_status + stock_quantity) ==`);
  let updated = 0;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const ids = chunk.map((t) => t.id);
    const { data, error } = await db
      .from('products')
      .update({ availability_status: 'out_of_stock', stock_quantity: 0 })
      .in('id', ids)
      .select('id');
    if (error) {
      console.error(
        `\nПомилка чанка ${i / CHUNK + 1} (рядки ${i}..${i + chunk.length - 1}): ${error.message}\n` +
          `Зупинка. Повторний запуск --apply ідемпотентно докатить решту (цілі перерахуються від свіжого стану БД).\n` +
          `Оновлено до помилки: ${updated}; знімок: ${snapshotPath}`
      );
      process.exit(2);
    }
    updated += (data ?? []).length;
    console.log(`  чанк ${i / CHUNK + 1}/${Math.ceil(targets.length / CHUNK)}: оновлено ${(data ?? []).length} (усього ${updated})`);
  }

  // ---- 6. post-write verification (read-only) -----------------------------
  // Read chunks stay at CHUNK (200): .in() with 1000 uuids builds a GET
  // URL long enough for PostgREST to reject it with Bad Request (seen
  // live on the first apply run) — the writes themselves are POSTs.
  let stillInStock = 0;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const ids = targets.slice(i, i + CHUNK).map((t) => t.id);
    const { data, error } = await db
      .from('products')
      .select('id, availability_status')
      .in('id', ids);
    if (error) throw new Error(`верифікація: select failed: ${error.message}`);
    for (const r of (data ?? []) as { availability_status: string | null }[]) {
      if (r.availability_status === 'in_stock') stillInStock += 1;
    }
  }
  const { count: oosAfter, error: countErr } = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('availability_status', 'out_of_stock');
  if (countErr) throw new Error(`верифікація: count failed: ${countErr.message}`);

  console.log('\n== Верифікація (read-only) ==');
  console.log(`  оновлено рядків: ${updated} з ${targets.length}`);
  console.log(`  цілей, що залишились in_stock: ${stillInStock} (має бути 0)`);
  console.log(
    `  out_of_stock серед активних: було ${oosBefore} (${((oosBefore / activeTotal) * 100).toFixed(1)}%), ` +
      `стало ${oosAfter} (${(((oosAfter ?? 0) / activeTotal) * 100).toFixed(1)}%)`
  );

  // ---- 7. summary vs the diagnostics expectation --------------------------
  console.log('\n== Підсумок ==');
  console.log(`  цілей знайдено: ${targets.length} (базових ${targetBase} / _du ${targetDu})`);
  console.log(`  оновлено: ${updated}; не торкнуто: ${activeYc.length - targets.length} товарів з yugcontract_id + manual ${activeTotal - activeYc.length}`);
  console.log(`  очікування з діагностики: базових ${EXPECTED_BASE} (розбіжність ${(devBase * 100).toFixed(1)}%), _du ${EXPECTED_DU} (розбіжність ${(devDu * 100).toFixed(1)}%)`);
  console.log(`  знімок для відкату: ${snapshotPath}`);
  if (stillInStock > 0 || updated !== targets.length) {
    console.error('Верифікація НЕ пройшла — див. вище та повторіть --apply (ідемпотентно).');
    process.exit(2);
  }
}

async function revertMode(snapshotFile: string): Promise<void> {
  const db = await createDbClient();
  const snap = JSON.parse(readFileSync(snapshotFile, 'utf8')) as SnapshotFile;
  if (snap.kind !== 'yugcontract-mark-missing-oos-snapshot' || !Array.isArray(snap.targets)) {
    throw new Error(`${snapshotFile} не є знімком цього скрипта`);
  }
  console.log(`== ВІДКАТ зі знімка ${snapshotFile} (version ${snap.script_version}, created ${snap.created_at}) ==`);
  console.log(`  рядків у знімку: ${snap.targets.length}`);

  // Group by identical old values so each group is a single chunked .in() update.
  const groups = new Map<string, SnapshotTarget[]>();
  for (const t of snap.targets) {
    const key = `${t.old_availability_status}\u0000${String(t.old_stock_quantity)}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  let updated = 0;
  for (const [key, group] of groups) {
    const [status = '', qtyRaw] = key.split('\u0000');
    const qty = qtyRaw === 'null' ? null : Number(qtyRaw);
    for (let i = 0; i < group.length; i += CHUNK) {
      const ids = group.slice(i, i + CHUNK).map((t) => t.id);
      const payload: { availability_status: string; stock_quantity: number | null } = {
        availability_status: status,
        stock_quantity: qty,
      };
      const { data, error } = await db.from('products').update(payload).in('id', ids).select('id');
      if (error) {
        console.error(`Помилка чанка відкату: ${error.message}. Оновлено до помилки: ${updated}. Повторний запуск --revert ідемпотентний.`);
        process.exit(2);
      }
      updated += (data ?? []).length;
    }
    console.log(`  група status=${status} qty=${String(qty)}: ${group.length} рядків — ок`);
  }

  // Verification: every snapshot row must now match its old values.
  // (Rows legitimately re-touched by the regular sync AFTER the revert
  // would show up here as mismatches — reported, not silently ignored.)
  let mismatches = 0;
  for (let i = 0; i < snap.targets.length; i += CHUNK) {
    const slice = snap.targets.slice(i, i + CHUNK);
    const byId = new Map(slice.map((t) => [t.id, t]));
    const { data, error } = await db
      .from('products')
      .select('id, availability_status, stock_quantity')
      .in('id', slice.map((t) => t.id));
    if (error) throw new Error(`верифікація відкату: select failed: ${error.message}`);
    for (const r of (data ?? []) as { id: string; availability_status: string | null; stock_quantity: number | null }[]) {
      const t = byId.get(r.id);
      if (
        t &&
        ((r.availability_status ?? '') !== t.old_availability_status ||
          (r.stock_quantity ?? null) !== (t.old_stock_quantity ?? null))
      ) {
        mismatches += 1;
      }
    }
  }
  console.log(`  відкат завершено: оновлено ${updated}; розбіжностей зі знімком: ${mismatches}`);
  if (mismatches > 0) {
    console.error('Увага: частина рядків не збігається зі знімком (можливі пізніші штатні зміни) — див. вище.');
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--apply')) {
    if (args.includes('--revert')) throw new Error('Обери щось одне: --apply або --revert');
    await applyMode();
    return;
  }
  if (args.includes('--revert')) {
    const idx = args.indexOf('--snapshot');
    const file = idx >= 0 ? args[idx + 1] : undefined;
    if (!file) throw new Error('Вкажіть --snapshot <файл> для режиму --revert');
    await revertMode(path.isAbsolute(file) ? file : path.join(root, file));
    return;
  }
  console.error(
    'Використання:\n' +
      '  node scripts/yugcontract-mark-missing-oos.ts --apply\n' +
      '  node scripts/yugcontract-mark-missing-oos.ts --revert --snapshot logs/oos-batch-<UTC date>.json'
  );
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error('Помилка:', err instanceof Error ? err.message : err);
  process.exit(2);
});
