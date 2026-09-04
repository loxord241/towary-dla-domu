/**
 * READ-ONLY post-run verification for Task #20 GO (SELECT only).
 * Spot-checks du + regular products against staging, aggregate counts,
 * and global safety scans (no overwrite of non-empty pre-run content is
 * verified structurally: overwrites were 0 in plan AND run).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const { createClient } = await import('@supabase/supabase-js');

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

type ProductRow = {
  id: string;
  yugcontract_id: string | null;
  sku: string;
  name: string;
  description: string | null;
  specifications: unknown;
  updated_at: string;
};
const products = (await pagedSelect(
  client,
  'products',
  'id,yugcontract_id,sku,name,description,specifications,updated_at',
  'id'
)) as ProductRow[];
type StagedRow = {
  yugcontract_id: string;
  description: string | null;
  params: unknown;
};
const staging = (await pagedSelect(
  client,
  'yc_content_goods',
  'yugcontract_id,description,params',
  'yugcontract_id'
)) as StagedRow[];
const stagingById = new Map(staging.map((r) => [r.yugcontract_id, r]));
const asParamPairs = (v: unknown): { name: string; value: string }[] =>
  Array.isArray(v)
    ? v.flatMap((e) =>
        typeof e === 'object' && e !== null &&
        typeof (e as { name?: unknown }).name === 'string' && typeof (e as { value?: unknown }).value === 'string'
          ? [{ name: (e as { name: string }).name, value: (e as { value: string }).value }]
          : []
      )
    : [];

const runWindow = { from: '2026-09-01T12:41:00', to: '2026-09-01T12:44:00' };
const runTouched = products.filter((p) => p.updated_at >= runWindow.from && p.updated_at <= runWindow.to);
const duTouched = runTouched.filter((p) => p.yugcontract_id?.endsWith('_du'));
const regTouched = runTouched.filter((p) => !p.yugcontract_id?.endsWith('_du'));

console.log(`== POST-RUN VERIFICATION (run=ycc-2026-09-01-12-41-47) ==`);
console.log(`products touched in run window: ${fmtInt(runTouched.length)} (expect 811; regular ${fmtInt(regTouched.length)} + _du ${fmtInt(duTouched.length)})`);

// du spot checks
const EXCLUDED = new Set(['7022284']); // base id whose desc is in the exclusion set
console.log('\n-- _du SPOT-CHECKS --');
for (const duId of ['5924679_du', '6376339_du', '7291169_du', '7022284_du', '7232093_du']) {
  const p = products.find((x) => x.yugcontract_id === duId);
  if (!p) { console.log(`  ${duId}: НЕ НАЙДЕНО`); continue; }
  const base = duId.replace(/_du$/, '');
  const s = stagingById.get(base);
  const stagedDesc = s?.description ?? null;
  const stagedParams = asParamPairs(s?.params);
  const descOk =
    (stagedDesc === null || EXCLUDED.has(base))
      ? p.description === null || p.description.trim() === ''
      : p.description?.trim() === stagedDesc.trim();
  const specsOk = JSON.stringify(p.specifications ?? null) === JSON.stringify(stagedParams.length > 0 ? stagedParams : null);
  const hasDesc = p.description !== null && p.description.trim() !== '';
  const hasSpecs = Array.isArray(p.specifications) && p.specifications.length > 0;
  console.log(
    `  ${duId}: desc=${hasDesc ? `${p.description!.length} chars` : 'порожньо'} (staged=${stagedDesc !== null ? 'є' : 'ні'}, excluded=${EXCLUDED.has(base)}) ✓=${descOk}; specs=${hasSpecs ? `${(p.specifications as unknown[]).length} pairs` : 'ні'} (staged=${stagedParams.length}) ✓=${specsOk}`
  );
}

// aggregates
const duAll = products.filter((p) => p.yugcontract_id?.endsWith('_du'));
const duWithDesc = duAll.filter((p) => p.description !== null && p.description.trim() !== '').length;
const duWithSpecs = duAll.filter((p) => Array.isArray(p.specifications) && p.specifications.length > 0).length;
console.log(`\n_aggregates_: _du ${fmtInt(duAll.length)}: з описом ${fmtInt(duWithDesc)} (очікується 80), зі specs ${fmtInt(duWithSpecs)} (очікується 129)`);

const allWithDesc = products.filter((p) => p.description !== null && p.description.trim() !== '').length;
const allWithSpecs = products.filter((p) => Array.isArray(p.specifications) && p.specifications.length > 0).length;
console.log(`всі товари: з описом ${fmtInt(allWithDesc)}, зі specs ${fmtInt(allWithSpecs)}`);

// regular spot: fresh fill sample (touched + previously-empty desc → has desc now)
const filled = regTouched.filter((p) => p.description !== null && p.description.trim() !== '').slice(0, 3);
console.log('\n-- REGULAR SPOT (заповнення за run) --');
for (const p of filled) {
  const s = stagingById.get(p.yugcontract_id ?? '');
  console.log(`  ${p.sku} (${p.yugcontract_id}): desc ${p.description?.length} chars ✓=${s?.description?.trim() === p.description?.trim()}`);
}

// global safety: no dangerous HTML in any description (sanitizer contract)
let dangerous = 0;
for (const p of products) {
  const d = p.description ?? '';
  if (/<script\b/i.test(d) || /\bon[a-z]+\s*=/i.test(d) || /javascript:/i.test(d)) dangerous += 1;
}
console.log(`\nглобальний скан описів: script/on*/javascript: = ${fmtInt(dangerous)} (очікується 0)`);
