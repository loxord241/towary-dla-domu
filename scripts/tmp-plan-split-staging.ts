/**
 * READ-ONLY plan split over CURRENT staging (no API call, SELECT only).
 * Decomposes the apply --plan into regular vs `_du` ops.
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

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

type StagedRow = {
  yugcontract_id: string;
  category_id: string | null;
  name: string | null;
  description: string | null;
  pictures: unknown;
  params: unknown;
};
const stagedRaw = (await pagedSelect(
  client,
  'yc_content_goods',
  'yugcontract_id,category_id,name,description,pictures,params',
  'yugcontract_id'
)) as StagedRow[];
const staged = stagedRaw.map((r) => ({
  yugcontract_id: r.yugcontract_id,
  category_id: r.category_id,
  name: r.name,
  description: r.description,
  pictures: Array.isArray(r.pictures) ? r.pictures.filter((v): v is string => typeof v === 'string') : [],
  params: Array.isArray(r.params)
    ? r.params.flatMap((e) =>
        typeof e === 'object' && e !== null &&
        typeof (e as { name?: unknown }).name === 'string' && typeof (e as { value?: unknown }).value === 'string'
          ? [{ name: (e as { name: string }).name, value: (e as { value: string }).value }]
          : []
      )
    : [],
}));

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

const plan = planContentUpdates(staged, products, { includeSpecifications: true });
const duOps = plan.updates.filter((u) => u.yugcontractId.endsWith('_du'));
const regOps = plan.updates.filter((u) => !u.yugcontractId.endsWith('_du'));

console.log(`staging rows: ${fmtInt(staged.length)}, products: ${fmtInt(products.length)}`);
console.log(`UPDATE total: ${fmtInt(plan.updates.length)} (regular ${fmtInt(regOps.length)} + _du ${fmtInt(duOps.length)})`);
const split = (ops: typeof plan.updates, label: string) => {
  console.log(`-- ${label} --`);
  console.log(`  fills desc:       ${fmtInt(ops.filter((u) => !u.currentHadDescription && u.fields.description).length)}`);
  console.log(`  overwrites desc:  ${fmtInt(ops.filter((u) => u.currentHadDescription && u.fields.description).length)}`);
  console.log(`  specs:            ${fmtInt(ops.filter((u) => u.fields.specifications).length)}`);
  console.log(`  desc+specs both:  ${fmtInt(ops.filter((u) => u.fields.description && u.fields.specifications).length)}`);
  // unexpected ops: neither field → impossible by planner; assert defensively
  console.log(`  unexpected (no fields): ${fmtInt(ops.filter((u) => !u.fields.description && !u.fields.specifications).length)}`);
};
split(regOps, 'REGULAR');
split(duOps, 'DU');
console.log(`identical ${fmtInt(plan.identical)}, noDesc ${fmtInt(plan.noDescriptionAvailable)}, unmatched ${fmtInt(plan.unmatchedStaged)}, excluded ${fmtInt(plan.excludedDescription)}`);
