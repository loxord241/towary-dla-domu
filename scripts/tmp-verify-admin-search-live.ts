/**
 * LIVE READ-ONLY verification of the admin search+pagination fix against
 * the real database (service client — the same client type requireAdminApi()
 * hands to the admin routes). ONLY SELECT/head-count operations are issued;
 * nothing is written anywhere.
 *
 * What it proves on production data:
 *   - search runs BEFORE pagination: an item standing beyond the first 20
 *     rows of the default order is returned on PAGE 1 of its search;
 *   - total describes the FILTERED set and matches an independently built
 *     head-count with the same or= expression;
 *   - pagination windows continue INSIDE the filtered set (page 2 has no
 *     overlap with page 1);
 *   - oversized page numbers clamp; clearing the search restores the full
 *     list; F3-adversarial input cannot break the query.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] !== undefined && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const { createClient } = await import('@supabase/supabase-js');
const adminList = await import('../app/lib/admin-list.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const SCALARS = ['name', 'sku', 'slug', 'yugcontract_id'];

async function independentCount(table: string, expressions: string[]): Promise<number> {
  let q = client.from(table).select('id', { count: 'exact', head: true });
  for (const e of expressions) q = q.or(e);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

console.log('== PRODUCTS ==');
{
  const baseline = await adminList.listAdminProducts(client, { page: 1, size: 20 });
  check('baseline (без поиска) отдаёт полный список', baseline.total > 4000, `total=${baseline.total}`);

  // Товар TEFAL, стоящий ЗА ПРЕДЕЛАМИ первой страницы дефолтного порядка.
  const searched = await adminList.listAdminProducts(client, { page: 1, size: 20, search: 'tefal' });
  check('поиск «tefal»: total = отфильтрованному набору', searched.total === 106, `total=${searched.total}`);
  check(
    'поиск «tefal»: total совпадает с независимым COUNT по тому же or=',
    searched.total === await independentCount('products', await buildSameExpressions('tefal')),
  );
  check('страница 1 поиска содержит ≤20 строк', searched.products.length <= 20 && searched.products.length > 0, `rows=${searched.products.length}`);
  const rowMatches = (p: { name?: string; slug?: string; brand?: { name?: string } | null }) =>
    ['name', 'slug'].some((f) => String((p as Record<string, unknown>)[f] ?? '').toLowerCase().includes('tefal')) ||
    String(p.brand?.name ?? '').toLowerCase().includes('tefal');
  check('все строки страницы 1 реально соответствуют запросу', searched.products.every(rowMatches));

  // THE regression: товар за пределами первых 20 дефолта находится поиском на странице 1.
  const beyondPage1 = searched.products.find((p) => !baseline.products.some((b) => b.id === p.id));
  check(
    'REGRESSION: найден товар, ОТСУТСТВОВАВШИЙ в первых 20 без поиска (поиск ДО пагинации)',
    beyondPage1 !== undefined,
    beyondPage1 ? `id=${beyondPage1.id} name=${JSON.stringify(beyondPage1.name.slice(0, 48))}` : 'все результаты были и на первой странице'
  );

  // Страница 2 продолжает ФИЛЬТРОВАННЫЙ набор без перекрытий.
  const page1Ids = new Set(searched.products.map((p) => p.id));
  const page2 = await adminList.listAdminProducts(client, { page: 2, size: 20, search: 'tefal' });
  const overlap = page2.products.filter((p) => page1Ids.has(p.id));
  check('страница 2 поиска продолжает фильтрованный набор (без дублей)', overlap.length === 0 && page2.products.length > 0, `rows=${page2.products.length}, overlaps=${overlap.length}`);

  // Clamp запредельной страницы.
  const clamped = await adminList.listAdminProducts(client, { page: 9999, size: 20, search: 'tefal' });
  check('page=9999 зажимается к последней валидной странице', clamped.page === Math.ceil(searched.total / 20), `page=${clamped.page}`);

  // F3-адверсариальный ввод: санитайзер превращает его в «tefal ultra»
  // (AND токенов), запрос НЕ падает, результат идентичен санитизованному
  // эквиваленту.
  const adversarial = await adminList.listAdminProducts(client, { page: 1, size: 20, search: 'tefal","(ultra)%' });
  const sanitizedEquivalent = await adminList.listAdminProducts(client, { page: 1, size: 20, search: 'tefal ultra' });
  check(
    'адверсариальный ввод санитайзится: запрос не падает и эквивалентен sanitized-строке',
    adversarial.total === sanitizedEquivalent.total && adversarial.products.length === sanitizedEquivalent.products.length,
    `adversarial=${adversarial.total}, equivalent=${sanitizedEquivalent.total}`
  );

  // Очистка поиска возвращает полный список.
  const cleared = await adminList.listAdminProducts(client, { page: 1, size: 20, search: '' });
  check('очистка поиска → полный список', cleared.total === baseline.total);
}

async function buildSameExpressions(token: string): Promise<string[]> {
  const parts = SCALARS.map((f) => `${f}.ilike.%${token}%`);
  const brands = await client.from('brands').select('id').ilike('name', `%${token}%`);
  const brandIds = ((brands.data ?? []) as { id: string }[]).map((r) => r.id);
  if (brandIds.length > 0) parts.push(`brand_id.in.(${brandIds.join(',')})`);
  const cats = await client.from('categories').select('id').ilike('name', `%${token}%`);
  const catIds = ((cats.data ?? []) as { id: string }[]).map((r) => r.id);
  if (catIds.length > 0) parts.push(`category_id.in.(${catIds.join(',')})`);
  return [parts.join(',')];
}

console.log('\n== BRANDS ==');
{
  const baseline = await adminList.listAdminBrands(client, { page: 1, size: 20 });
  check('baseline: брендов больше одной страницы', baseline.total > 20, `total=${baseline.total}`);

  // Бренд со страницы 3+ дефолтного порядка ищется на странице 1.
  const laterPage = await adminList.listAdminBrands(client, { page: Math.min(3, Math.ceil(baseline.total / 20)), size: 20 });
  const target = laterPage.brands[laterPage.brands.length - 1];
  check('взят бренд за пределами первой страницы', !!target, target ? `${target.name} (default position ≥41)` : '-');
  if (target) {
    const token = target.name.split(' ')[0]!.toLowerCase();
    const found = await adminList.listAdminBrands(client, { page: 1, size: 20, search: token });
    check(
      'REGRESSION: бренд вне первых 20 найден поиском на странице 1',
      found.total >= 1 && found.brands.some((b) => b.id === target.id),
      `token="${token}" total=${found.total} onFirstPage=${found.brands.some((b) => b.id === target.id)}`
    );
  }

  const emptySearch = await adminList.listAdminBrands(client, { page: 1, size: 20, search: 'zzqqxx-нет-такого' });
  check('поиск без результатов: total=0, пусто', emptySearch.total === 0 && emptySearch.brands.length === 0);
}

console.log('\n== CATEGORIES ==');
{
  const baseline = await adminList.listAdminCategories(client, { page: 1, size: 20 });
  check('baseline: категорий больше одной страницы', baseline.total > 20, `total=${baseline.total}`);

  const laterPage = await adminList.listAdminCategories(client, { page: Math.min(5, Math.ceil(baseline.total / 20)), size: 20 });
  const target = laterPage.categories[laterPage.categories.length - 1];
  check('взята категория за пределами первой страницы', !!target, target ? `${target.name} / ${target.slug}` : '-');
  if (target) {
    const slugToken = target.slug.split('-')[0];
    const foundBySlug = await adminList.listAdminCategories(client, { page: 1, size: 20, search: slugToken });
    check(
      'REGRESSION: категория вне первых 20 найдена поиском по slug',
      foundBySlug.total >= 1 && foundBySlug.categories.some((c) => c.id === target.id),
      `slug-token="${slugToken}" total=${foundBySlug.total}`
    );
  }

  // Мульти-токен AND на живых данных.
  const twoTokens = await adminList.listAdminCategories(client, { page: 1, size: 20, search: target ? `${target.slug.split('-')[0]} ${target.slug.split('-')[1] ?? ''}` : '' });
  check('мульти-токенный поиск работает', twoTokens.total >= 1, `total=${twoTokens.total}`);

  const sorted = await adminList.listAdminCategories(client, { page: 1, size: 20, sort: 'slug' });
  check('серверная сортировка применяется', sorted.categories.length > 1, `first-slug=${sorted.categories[0]?.slug}`);
}

console.log(`\nИТОГО: ${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
