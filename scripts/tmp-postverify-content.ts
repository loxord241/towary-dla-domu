/**
 * Read-only POST-RUN content verification. Zero writes.
 *   node scripts/tmp-postverify-content.ts
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

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!url || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(url, serviceKey, { auth: { persistSession: false } });

/** Unique key per table: stable multi-page windows need ORDER BY. */
function orderKey(table: string): string {
  return table === 'yc_content_goods' ? 'yugcontract_id' : 'id';
}

async function selectAll(table: string, select: string): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client.from(table).select(select).order(orderKey(table)).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as Record<string, unknown>[]));
    if ((data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');
const DANGER: RegExp[] = [
  /<script/i,
  /\bon[a-z]+\s*=/i,
  /javascript:/i,
  /data:/i,
  /<iframe/i,
  /\bstyle\s*=/i,
];

// ---- 1) checkpoints ------------------------------------------------------------
console.log('== CHECKPOINTS yc_content_batches ==');
const batches = await selectAll('yc_content_batches', '*');
const byStatus = new Map<string, number>();
let sumUpdated = 0;
let sumSkipped = 0;
let sumErrors = 0;
for (const b of batches) {
  byStatus.set(String(b.status), (byStatus.get(String(b.status)) ?? 0) + 1);
  sumUpdated += Number(b.updated_count ?? 0);
  sumSkipped += Number(b.skipped_count ?? 0);
  sumErrors += Number(b.error_count ?? 0);
}
console.log(`всього батчів: ${fmtInt(batches.length)}`);
for (const [status, n] of [...byStatus.entries()].sort()) console.log(`  ${status}: ${fmtInt(n)}`);
console.log(
  `сумарні counters: updated=${fmtInt(sumUpdated)}, skipped=${fmtInt(sumSkipped)}, errors=${fmtInt(sumErrors)}`
);

// ---- 2) products counters --------------------------------------------------------
console.log('\n== PRODUCTS ==');
const products = await selectAll(
  'products',
  'id,yugcontract_id,sku,name,description,specifications'
);
const ycLinked = products.filter((p) => p.yugcontract_id !== null);
const withDesc = ycLinked.filter(
  (p) => typeof p.description === 'string' && p.description.trim() !== ''
);
const emptyDesc = ycLinked.filter(
  (p) => !(typeof p.description === 'string' && p.description.trim() !== '')
);
const withSpecs = ycLinked.filter((p) => p.specifications !== null && p.specifications !== undefined);
console.log(`products: ${fmtInt(products.length)} (очікувано 4323)`);
console.log(`YC-linked: ${fmtInt(ycLinked.length)} (очікувано 4322)`);
console.log(`YC-linked з непорожнім description: ${fmtInt(withDesc.length)} (очікувано 3399)`);
console.log(`YC-linked з ПОРОЖНІМ description: ${fmtInt(emptyDesc.length)} (очікувано 923)`);
console.log(
  `YC-linked зі specifications ≠ null: ${fmtInt(withSpecs.length)} (очікувано 4081)`
);
const manual = products.filter((p) => p.yugcontract_id === null);
console.log(
  `manual товарів: ${manual.length}; їх описи/специфікації: ${manual
    .map((m) => `desc=${typeof m.description === 'string' ? m.description.length : 'null'} chars, specs=${m.specifications === null ? 'null' : 'set'}`)
    .join('; ')}`
);

// ---- 3) spot checks ---------------------------------------------------------------
console.log('\n== SPOT CHECKS ==');
const goods = await selectAll(
  'yc_content_goods',
  'yugcontract_id,name,description,params'
);
interface Param {
  name: string;
  value: string;
}
function paramsOf(raw: unknown): Param[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (p): p is Param =>
      typeof p === 'object' && p !== null &&
      typeof (p as Param).name === 'string' && typeof (p as Param).value === 'string'
  );
}

const byYc = new Map(products.map((p) => [String(p.yugcontract_id), p]));

// a) a good WITH description
const sampleA = goods.find(
  (g) => byYc.has(String(g.yugcontract_id)) &&
    typeof g.description === 'string' && g.description.includes('<')
);
// b) a matched good WITHOUT description but WITH params
const sampleB = goods.find((g) => {
  const p = byYc.get(String(g.yugcontract_id));
  return p && (!(typeof g.description === 'string' && g.description.trim() !== '')) && paramsOf(g.params).length > 0;
});
// c) a matched good with duplicate param names AND different values
function hasDupConflict(raw: unknown): boolean {
  const ps = paramsOf(raw);
  const byName = new Map<string, Set<string>>();
  for (const p of ps) {
    const set = byName.get(p.name) ?? new Set<string>();
    set.add(p.value);
    byName.set(p.name, set);
  }
  return [...byName.values()].some((s) => s.size > 1);
}
const sampleC = goods.find((g) => byYc.has(String(g.yugcontract_id)) && hasDupConflict(g.params));

function check(label: string, yid: string | undefined): void {
  if (!yid) {
    console.log(`${label}: не знайдено`);
    return;
  }
  const prod = byYc.get(yid)!;
  const desc = typeof prod.description === 'string' ? prod.description : '';
  const dangerous = DANGER.some((re) => re.test(desc));
  const specsRaw = prod.specifications;
  const isArray = Array.isArray(specsRaw);
  console.log(`\n${label}: sku=${String(prod.sku)} (yc id=${yid})`);
  console.log(
    `  description: ${desc.length} символів; початок: ${JSON.stringify(desc.slice(0, 90))}${desc.length > 90 ? '…' : ''}`
  );
  console.log(`  небезпечні конструкції в БД-описі: ${dangerous ? 'ЗНАЙДЕНО!' : 'немає'}`);
  if (!isArray) {
    console.log(`  specifications: НЕ масив (${typeof specsRaw})`);
    return;
  }
  const specs = specsRaw as unknown[];
  const validPairs = specs.every(
    (e) =>
      typeof e === 'object' && e !== null &&
      typeof (e as Param).name === 'string' && typeof (e as Param).value === 'string'
  );
  console.log(
    `  specifications: JSON array, ${specs.length} елементів, всі {name,value}: ${validPairs}`
  );
  const dupConflicts = hasDupConflict(specsRaw);
  if (label.startsWith('C')) {
    const byName = new Map<string, string[]>();
    for (const p of paramsOf(specsRaw)) {
      const arr = byName.get(p.name) ?? [];
      arr.push(p.value);
      byName.set(p.name, arr);
    }
    for (const [name, values] of byName) {
      if (values.length > 1) {
        console.log(`  повторюване name зі збереженими різними values: "${name}" → [${values.map((v) => JSON.stringify(v.slice(0, 30))).join(', ')}]`);
      }
    }
  } else if (!dupConflicts) {
    console.log('  конфліктів дубльованих name немає (як і очікувалось для цього зразка)');
  }
}

check('A (з описом)', sampleA ? String(sampleA.yugcontract_id) : undefined);
check('B (без опису, з params)', sampleB ? String(sampleB.yugcontract_id) : undefined);
check('C (дублі name з різними values)', sampleC ? String(sampleC.yugcontract_id) : undefined);

// global danger scan over ALL YC-linked descriptions in DB
let dangerCount = 0;
for (const p of ycLinked) {
  const d = typeof p.description === 'string' ? p.description : '';
  if (d !== '' && DANGER.some((re) => re.test(d))) dangerCount += 1;
}
console.log(`\nГлобальний скан: небезпечних конструкцій у ${fmtInt(withDesc.length)} описах у БД: ${fmtInt(dangerCount)}`);
