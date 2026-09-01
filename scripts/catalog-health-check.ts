/**
 * READ-ONLY production health check for the catalog + Yugcontract sync.
 *
 * Contract (monitoring stage 2026-08-28):
 *  - performs ONLY `.select()` Supabase queries — no insert/update/upsert/
 *    delete/rpc calls, no schema changes, no importer invocation;
 *  - classifies results via the pure lib app/lib/monitoring/catalog-health.ts
 *    (PASS/WARN/FAIL + systemd-friendly exit code 0/1/2);
 *  - the imageless-products section reports the exact count AND the full
 *    list (yugcontract_id, sku, slug, name) — fixing those products is a
 *    separate content task and is intentionally NOT attempted here;
 *  - the _du section (2026-08-31 allowlist audit) compares the live _du
 *    rows against the generated allowlist (du-redirects.ts): FAIL on new
 *    _du pairs outside the allowlist or broken known pairs, WARN on
 *    price-drift / orphan-count drift ⇒ regenerate the allowlist.
 *
 * Usage: node scripts/catalog-health-check.ts
 * Exit:  0 = PASS, 1 = WARN, 2 = FAIL (see catalog-health.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildCatalogChecks,
  overallResult,
  analyzeDuDrift,
  DU_EXPECTED_ORPHANS,
  type ImportBatchInfo,
  type DuProductRow,
} from '../app/lib/monitoring/catalog-health.ts';
import {
  DU_PRICE_DIFF_PAIRS,
  DU_REDIRECT_PAIRS,
  DU_ALLOWLIST_AUDIT_DATE,
} from '../app/lib/du-redirects.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env.local only (same pattern as the other scripts) — no secrets are
// printed anywhere below.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const PAGE = 1000;

/** Paged read-only select; returns all rows of a table/query. */
async function fetchAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeQuery: (from: number, limit: number) => any
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery(from, PAGE);
    if (error) throw new Error(`select failed: ${error.message}`);
    const chunk = (data ?? []) as Record<string, unknown>[];
    rows.push(...chunk);
    if (chunk.length < PAGE) return rows;
    from += PAGE;
  }
}

async function main(): Promise<void> {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error('Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    process.exit(2);
  }
  // Service-role client used for READS ONLY (RLS must not hide monitoring
  // data); the write-call ban is enforced by tests/catalog-health.test.ts.
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const now = new Date();

  // ---- 1. active products (single paged read, minimal columns) -----------
  const products = await fetchAll((from, limit) =>
    db
      .from('products')
      .select('id, yugcontract_id, sku, slug, name, price')
      .eq('is_active', true)
      .order('id')
      .range(from, from + limit - 1)
  );
  const activeTotal = products.length;
  const noYcId = products.filter((p) => p.yugcontract_id === null);
  const noPrice = products.filter((p) => p.price === null);
  const nonPositivePrice = products.filter(
    (p) => typeof p.price === 'number' && p.price <= 0
  );

  // ---- 2. junction + image parent ids (paged reads) ----------------------
  const categorizedIds = new Set(
    (
      await fetchAll((from, limit) =>
        db.from('product_categories').select('product_id').order('product_id').range(from, from + limit - 1)
      )
    ).map((r) => r.product_id)
  );
  const withImageIds = new Set(
    (
      await fetchAll((from, limit) =>
        db.from('product_images').select('product_id').order('product_id').range(from, from + limit - 1)
      )
    ).map((r) => r.product_id)
  );

  const noCategoryCount = products.filter((p) => !categorizedIds.has(p.id)).length;
  const noImageProducts = products.filter((p) => !withImageIds.has(p.id));
  const noImageItems = noImageProducts.map(
    (p) =>
      `${p.yugcontract_id ?? 'manual'} | ${p.sku ?? '—'} | ${p.slug} | ${p.name}`
  );

  // ---- 3. import batches (small table) -----------------------------------
  // The callback MUST consume (from, limit): PostgREST caps any response
  // at 1000 rows, and a range-less callback re-fetches the same first
  // page forever once the table reaches the cap.
  const batches = (
    await fetchAll((from, limit) =>
      db
        .from('yc_import_batches')
        .select('run_id, phase, batch_no, status, started_at, finished_at, last_error')
        .order('id')
        .range(from, from + limit - 1)
    )
  ) as unknown as ImportBatchInfo[];

  // ---- 4. _du allowlist drift (read-only, mirrors the generator's gates) --
  // Same two reads the generator does, minus the full base scan: only the
  // ~103 allowlisted base ids are fetched. No writes anywhere.
  const duRows = (await fetchAll((from, limit) =>
    db
      .from('products')
      .select('yugcontract_id, slug, price')
      .like('yugcontract_id', '%\\_du')
      .order('yugcontract_id')
      .range(from, from + limit - 1)
  )) as unknown as DuProductRow[];
  const allowlistDuIds = [
    ...DU_REDIRECT_PAIRS.map((p) => p.duYc),
    ...DU_PRICE_DIFF_PAIRS.map((p) => p.duYc),
  ];
  const baseRows = (
    await fetchAll((from, limit) =>
      db
        .from('products')
        .select('yugcontract_id, slug, price')
        .in('yugcontract_id', allowlistDuIds.map((id) => id.replace(/_du$/, '')))
        .order('yugcontract_id')
        .range(from, from + limit - 1)
    )
  ) as unknown as DuProductRow[];
  const duDrift = analyzeDuDrift({
    duRows,
    baseRows,
    allowlist: {
      duIds: new Set(allowlistDuIds),
      priceDiffIds: new Set(DU_PRICE_DIFF_PAIRS.map((p) => p.duYc)),
      expectedOrphans: DU_EXPECTED_ORPHANS,
    },
  });

  // ---- 5. pending orders (advisory; existing safe read-only logic) -------
  // The callback MUST consume (from, limit): a range-less query loops forever
  // once pending count reaches the PostgREST 1000-row response cap.
  const pendingOrders = await fetchAll((from, limit) =>
    db
      .from('orders')
      .select('order_number, created_at')
      .eq('payment_status', 'pending')
      .order('order_number')
      .range(from, from + limit - 1)
  );
  const pending24h = pendingOrders.filter(
    (o) =>
      o.created_at !== null &&
      now.getTime() - new Date(String(o.created_at)).getTime() >
        24 * 60 * 60 * 1000
  ).length;

  // ---- 5. classify + report ----------------------------------------------
  const checks = buildCatalogChecks({
    now,
    counts: {
      activeTotal,
      noYcId: noYcId.length,
      noCategory: noCategoryCount,
      noImages: noImageProducts.length,
      noPrice: noPrice.length,
      nonPositivePrice: nonPositivePrice.length,
    },
    noImageItems,
    batches,
    pendingOrdersOlderThan24h: pending24h,
    du: {
      duRows,
      baseRows,
      allowlist: {
        duIds: new Set(allowlistDuIds),
        priceDiffIds: new Set(DU_PRICE_DIFF_PAIRS.map((p) => p.duYc)),
        expectedOrphans: DU_EXPECTED_ORPHANS,
      },
    },
  });
  const { status, exitCode } = overallResult(checks);

  console.log(`# Catalog health check — ${now.toISOString()} (READ-ONLY)`);
  console.log(`# Активних товарів: ${activeTotal}`);
  for (const c of checks) {
    const tag = c.level.toUpperCase().padEnd(4);
    console.log(`[${tag}] ${c.label}: ${c.count} — ${c.description}`);
  }

  if (noImageProducts.length > 0) {
    console.log(
      `\n# Товари без зображень (${noImageProducts.length}) — yugcontract_id | SKU | slug | name:`
    );
    for (const item of noImageItems) console.log(`  ${item}`);
  }

  const failed = batches.filter((b) => b.status === 'failed');
  if (failed.length > 0) {
    console.log('\n# Failed batches:');
    for (const b of failed) {
      console.log(`  run=${b.run_id} phase=${b.phase} batch=${b.batch_no} err=${b.last_error ?? '—'}`);
    }
  }

  if (
    duDrift.unknownDu.length > 0 ||
    duDrift.missingDu.length > 0 ||
    duDrift.brokenPairs.length > 0 ||
    duDrift.priceDrift.length > 0 ||
    duDrift.orphanCount !== DU_EXPECTED_ORPHANS
  ) {
    console.log(
      `\n# _du drift (allowlist audit ${DU_ALLOWLIST_AUDIT_DATE}): du=${duDrift.duTotal}, orphans=${duDrift.orphanCount}/${DU_EXPECTED_ORPHANS}`
    );
    for (const [title, list] of [
      ['нові _du поза allowlist', duDrift.unknownDu],
      ['зниклі allowlist _du', duDrift.missingDu],
      ['зламані пари', duDrift.brokenPairs],
      ['price-drift', duDrift.priceDrift],
    ] as const) {
      if (list.length === 0) continue;
      console.log(`  ${title} (${list.length}):`);
      for (const item of list) console.log(`    ${item}`);
    }
  }

  console.log(`\nRESULT: ${status} (exit ${exitCode})`);
  process.exit(exitCode);
}

main().catch((err: unknown) => {
  console.error('health-check failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
