/**
 * READ-ONLY probe #2: since embed paths INSIDE or= fail to parse on the
 * live PostgREST ("failed to parse logic tree"), test the fallback shape:
 * resolve matching brand/category UUIDs first, then reference the FK
 * columns via `in.(...)` branches INSIDE or=.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { createClient } = await import('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '',
  { auth: { persistSession: false } }
);

const SCALAR_FIELDS = ['name', 'sku', 'slug', 'yugcontract_id'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countWith(label: string, q: any): Promise<number | null> {
  const { count, error } = await q;
  if (error) {
    console.log(`${label.padEnd(58)} ERROR ${error.code ?? ''}: ${error.message.slice(0, 80)}`);
    return null;
  }
  console.log(`${label.padEnd(58)} = ${count}`);
  return count ?? null;
}

async function idsByIlike(table: string, token: string): Promise<string[]> {
  const { data, error } = await client.from(table).select('id').ilike('name', `%${token}%`);
  if (error) {
    console.log(`idsByIlike(${table}) ERROR: ${error.message.slice(0, 100)}`);
    return [];
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

const TOKEN = 'tefal';

console.log('== ШАГ 1: резолв id ==');
const brandIds = await idsByIlike('brands', TOKEN);
console.log(`брендов с "${TOKEN}" в имени: ${brandIds.length}`);
const catIds = await idsByIlike('categories', TOKEN);
console.log(`категорий с "${TOKEN}" в имени: ${catIds.length}`);

console.log('\n== ШАГ 2: or=(scalars..., brand_id.in.(...)) ==');
{
  const exprParts = SCALAR_FIELDS.map((f) => `${f}.ilike.%${TOKEN}%`);
  if (brandIds.length > 0) exprParts.push(`brand_id.in.(${brandIds.join(',')})`);
  if (catIds.length > 0) exprParts.push(`category_id.in.(${catIds.join(',')})`);
  const expr = exprParts.join(',');
  console.log(`длина выражения: ${expr.length} симв.`);
  const c1 = await countWith('COUNT head:true + or(in-branches)', client.from('products').select('id', { count: 'exact', head: true }).or(expr));
  // ground truth union по компонентам (по отдельности)
  let sum = 0;
  for (const f of SCALAR_FIELDS) {
    const n = await countWith(`  компонент ${f}`, client.from('products').select('id', { count: 'exact', head: true }).ilike(f, `%${TOKEN}%`));
    sum += n ?? 0;
  }
  let brandCount: number | null = null;
  if (brandIds.length > 0) {
    brandCount = await countWith('  компонент brand_id.in.(...)', client.from('products').select('id', { count: 'exact', head: true }).in('brand_id', brandIds));
  }
  let catCount: number | null = null;
  if (catIds.length > 0) {
    catCount = await countWith('  компонент category_id.in.(...)', client.from('products').select('id', { count: 'exact', head: true }).in('category_id', catIds));
  }
  console.log(`union=${c1}; scalar-sum(с пересечениями)=${sum}, brand=${brandCount}, cat=${catCount}`);
}

console.log('\n== ШАГ 3: пагинация поверх составного or() ==');
{
  const exprParts = SCALAR_FIELDS.map((f) => `${f}.ilike.%${TOKEN}%`);
  if (brandIds.length > 0) exprParts.push(`brand_id.in.(${brandIds.join(',')})`);
  if (catIds.length > 0) exprParts.push(`category_id.in.(${catIds.join(',')})`);
  const { data, error } = await client
    .from('products')
    .select('id,name,brands(name),categories(name)')
    .or(exprParts.join(','))
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, 19);
  if (error) console.log(`paged ERROR: ${error.message.slice(0, 120)}`);
  else {
    console.log(`paged window вернул ${(data ?? []).length} строк`);
    for (const row of (data ?? []).slice(0, 3) as { name: string; brands: { name: string } | null }[]) {
      console.log(`  sample: ${JSON.stringify(row.name.slice(0, 44))} / brand=${JSON.stringify(row.brands?.name ?? null)}`);
    }
  }
}

console.log('\n== ШАГ 4: БОЛЬШОЙ in() — все бренды с "%a%" (35 шт) в or()==');
{
  const many = await idsByIlike('brands', 'a');
  const expr = [...SCALAR_FIELDS.map((f) => `${f}.ilike.%a%`), ...(many.length ? [`brand_id.in.(${many.join(',')})`] : [])].join(',');
  console.log(`выражение ${expr.length} симв., брендов в in(): ${many.length}`);
  await countWith('COUNT с большим in() внутри or()', client.from('products').select('id', { count: 'exact', head: true }).or(expr));
}

console.log('\n== ШАГ 5: пустой список in.() — поведение при 0 совпадений ==');
{
  // несуществующий токен → brandIds=[] → ветку in() просто не добавляем (проверяем форму без неё)
  const none = await idsByIlike('brands', 'zzqqxxzz');
  console.log(`совпадений нет: ${none.length === 0}`);
  const c = await countWith('COUNT только scalar-ветки (без in())', client.from('products').select('id', { count: 'exact', head: true }).or(SCALAR_FIELDS.map((f) => `${f}.ilike.%zzqqxxzz%`).join(',')));
  console.log(c === 0 ? 'OK: 0 совпадений корректно' : `ВНИМАНИЕ: ${c}`);
}

console.log('\n== ШАГ 6: мульти-токен AND: два .or() подряд (scalar+in) ==');
{
  const b2 = await idsByIlike('brands', 'мультипіч');
  const parts2 = [...SCALAR_FIELDS.map((f) => `${f}.ilike.%мультипіч%`), ...(b2.length ? [`brand_id.in.(${b2.join(',')})`] : [])];
  const parts1 = [...SCALAR_FIELDS.map((f) => `${f}.ilike.%tefal%`), ...(brandIds.length ? [`brand_id.in.(${brandIds.join(',')})`] : [])];
  await countWith('.or(tefal…).or(мультипіч…)', client.from('products').select('id', { count: 'exact', head: true }).or(parts1.join(',')).or(parts2.join(',')));
}
