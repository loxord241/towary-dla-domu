/**
 * READ-ONLY Task #20 verification: fresh-feed plan split regular vs `_du`.
 * ONE get-content-goods call + SELECT only. ZERO writes. Decomposes the
 * 863-ориентир: plan(products all) vs plan(products without _du twins).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const { createClient } = await import('@supabase/supabase-js');
const { getContentGoodsWithMeta } = await import('../app/lib/yugcontract/client.ts');
const { extractContentGoods, normalizeContentGood, dedupeContentGoods } = await import(
  '../app/lib/yugcontract/content-dry-run.ts'
);
const { reduceGoodsToStagedRows } = await import('../app/lib/yugcontract/content-staging.ts');
const { planContentUpdates } = await import('../app/lib/yugcontract/content-import.ts');

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

async function pagedSelect(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  table: string,
  select: string,
  orderCol: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const PAGE = 1000;
  const rows: unknown[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(select)
      .order(orderCol)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
    from += PAGE;
  }
}

console.log('== TASK #20 FRESH-FEED PLAN SPLIT (READ-ONLY) ==');
const t0 = Date.now();
const { parsed } = await getContentGoodsWithMeta();
const { goods: rawGoods } = extractContentGoods(parsed);
const validGoods = [];
for (const raw of rawGoods) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
  const { good } = normalizeContentGood(raw as Record<string, unknown>);
  if (good) validGoods.push(good);
}
const deduped = dedupeContentGoods(validGoods);
const staged = reduceGoodsToStagedRows(deduped.unique).rows;
console.log(`feed unique=${fmtInt(deduped.unique.length)}, staged rows=${fmtInt(staged.length)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);
type ProductRow = {
  id: string;
  yugcontract_id: string | null;
  description: string | null;
  specifications: unknown;
};
const products = (await pagedSelect(
  client,
  'products',
  'id,yugcontract_id,description,specifications',
  'id'
)) as ProductRow[];
console.log(`products: ${fmtInt(products.length)}`);

const duProducts = products.filter((p) => p.yugcontract_id?.endsWith('_du'));
const regular = products.filter((p) => !p.yugcontract_id?.endsWith('_du'));

const planFull = planContentUpdates(staged, products, { includeSpecifications: true });
const planRegular = planContentUpdates(staged, regular, { includeSpecifications: true });

const duOps = planFull.updates.filter((u) => u.yugcontractId.endsWith('_du'));
const regularOpsFull = planFull.updates.filter((u) => !u.yugcontractId.endsWith('_du'));

console.log('\n-- FULL PLAN --');
console.log(`updates:              ${fmtInt(planFull.updates.length)} (fills ${fmtInt(planFull.updates.filter((u) => !u.currentHadDescription && u.fields.description).length)}, overwrites ${fmtInt(planFull.updates.filter((u) => u.currentHadDescription && u.fields.description).length)}, specs ${fmtInt(planFull.updates.filter((u) => u.fields.specifications).length)})`);
console.log(`identical:            ${fmtInt(planFull.identical)} | noDesc: ${fmtInt(planFull.noDescriptionAvailable)} | unmatchedStaged: ${fmtInt(planFull.unmatchedStaged)}`);

console.log('\n-- SPLIT --');
console.log(`regular ops (full):   ${fmtInt(regularOpsFull.length)} | regular-only plan: ${fmtInt(planRegular.updates.length)} | identical: ${fmtInt(planFull.identical)} vs ${fmtInt(planRegular.identical)} | noDesc: ${fmtInt(planFull.noDescriptionAvailable)} vs ${fmtInt(planRegular.noDescriptionAvailable)} | unmatched: ${fmtInt(planFull.unmatchedStaged)} vs ${fmtInt(planRegular.unmatchedStaged)}`);
console.log(`du ops:               ${fmtInt(duOps.length)}`);
console.log(`  du desc fills:      ${fmtInt(duOps.filter((u) => !u.currentHadDescription && u.fields.description).length)}`);
console.log(`  du desc overwrites: ${fmtInt(duOps.filter((u) => u.currentHadDescription && u.fields.description).length)}`);
console.log(`  du specs:           ${fmtInt(duOps.filter((u) => u.fields.specifications).length)}`);
console.log(`  du desc+specs both: ${fmtInt(duOps.filter((u) => u.fields.description && u.fields.specifications).length)}`);

// du products NOT planned (base staged row absent in fresh feed)
const duPlannedIds = new Set(duOps.map((u) => u.productDbId));
const duNotPlanned = duProducts.filter((p) => !duPlannedIds.has(p.id));
console.log(`du без op (base id немає в свіжому фіді): ${fmtInt(duNotPlanned.length)} → ${duNotPlanned.map((p) => p.yugcontract_id).join(', ')}`);

const regularOnlyOps = planRegular.updates;
const missing = regularOpsFull.filter(
  (u) => !regularOnlyOps.some((v) => v.productDbId === u.productDbId && JSON.stringify(v.fields) === JSON.stringify(u.fields))
).length;
console.log(`regular ops differ full-vs-regular-only: ${fmtInt(missing)} (очікується 0 — du не впливає на regular)`);

console.log('\nZERO writes. Тривалість:', ((Date.now() - t0) / 1000).toFixed(0), 'с');
