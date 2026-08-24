/**
 * READ-ONLY probe: which characters actually break the PostgREST
 * `or=` grammar used by catalog search? Mirrors fetchCatalogProducts
 * expression construction exactly. SELECT only.
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

const currentSanitize = (t: string): string => t.replace(/[%,()]/g, ' ').trim();

async function probe(label: string, term: string, sanitize: ((t: string) => string) | null): Promise<void> {
  const t = sanitize ? sanitize(term) : term;
  const expr = [`name.ilike.%${t}%`, `short_description.ilike.%${t}%`].join(',');
  const { data, error } = await client
    .from('products')
    .select('id')
    .eq('is_active', true)
    .or(expr)
    .limit(1);
  const status = error ? `ERROR ${error.code ?? ''}` : `OK rows>0=${(data ?? []).length > 0}`;
  console.log(`${label.padEnd(34)} term=${JSON.stringify(t).padEnd(26)} → ${status}${error ? ` (${error.message.slice(0, 60)})` : ''}`);
}

console.log('== RAW (без санитайзера — чувствительность грамматики) ==');
await probe('cyrillic baseline', 'космос', null);
await probe('spaces+digits+latin', 'фото 10x15 sony', null);
await probe('hyphen', 'philips-oneblade', null);
await probe('apostrophe', "l'oreal", null);
await probe('dot', 'фото 10x15.', null);
await probe('RAW comma', 'foo,bar', null);
await probe('RAW parens', '(альбом)', null);
await probe('RAW percent', '100%', null);
await probe('RAW balanced dquote', '"война"', null);
await probe('RAW unbalanced dquote', 'foo"bar', null);
await probe('RAW colon', 'часы: мужские', null);

console.log('\n== ПОД ТЕКУЩИМ санитайзером [%,()→space] ==');
for (const [label, term] of [
  ['comma через санитайзер', 'foo,bar'],
  ['parens через санитайзер', '(альбом)'],
  ['DQUOTE balanced', '"война"'],
  ['DQUOTE unbalanced', 'foo"bar'],
  ['colon', 'часы: мужские'],
  ['dot', 'a.b'],
  ["apostrophe", "l'oreal"],
] as const) {
  await probe(label, term, currentSanitize);
}

console.log('\n== DQUOTE ПОЗИЦИОННЫЕ КЕЙСЫ (текущий санитайзер НЕ режет кавычки) ==');
for (const [label, term] of [
  ['leading dquote', '"война'],
  ['trailing dquote', 'война"'],
  ['lone dquote', '"'],
  ['leading balanced (фраза в кавычках)', '"iphone 15"'],
  ['mid quotes', 'say "hello" world'],
] as const) {
  await probe(label, term, currentSanitize);
}

console.log('\n== ДЕЦИЗИВНЫЙ ТЕСТ: кавычка как литерал ==');
const { data: quoted } = await client
  .from('products')
  .select('slug,name')
  .ilike('name', '%"%')
  .eq('is_active', true)
  .limit(3);
console.log(`товаров с " в названии найдено: ${(quoted ?? []).length}`);
for (const p of (quoted ?? []) as { slug: string; name: string }[]) {
  await probe(`full-name-with-quote [${String(p.name).slice(0, 24)}…]`, String(p.name), currentSanitize);
}

console.log('\n== КОНТРОЛЬ: та же строка без кавычки + товар без кавычки ==');
const q1 = (quoted ?? [])[0] as { name: string } | undefined;
if (q1) {
  await probe('same name, quote REMOVED', String(q1.name).replace(/"/g, ''), currentSanitize);
}
// sanity: точное имя товара БЕЗ кавычек должно находиться
const { data: plain } = await client.from('products').select('name').eq('is_active', true).not('name', 'ilike', '%"%').limit(1);
if ((plain ?? []).length > 0) {
  await probe('exact name without any quote', String((plain ?? [])[0] ? (plain as { name: string }[])[0].name : ''), currentSanitize);
}

console.log('\n== ФИНАЛЬНЫЕ ПОДТВЕРЖДЕНИЯ ==');
if ((quoted ?? []).length > 0) {
  const nm = String((quoted ?? [])[0]?.name ?? '');
  const fixed = nm.replace(/[%,()"]/g, ' ').trim();
  await probe('имя с кавычкой+parens, НОВЫЙ санитайзер', fixed, null);
}
// реальные товары с : . - в имени — должны находиться КАК ЕСТЬ (без стрипа)
const { data: colonProd } = await client.from('products').select('name').eq('is_active', true).ilike('name', '%:%').limit(1);
const { data: dotProd } = await client.from('products').select('name').eq('is_active', true).ilike('name', '%. %').limit(1);
console.log(`товаров с ':' в имени: ${(colonProd ?? []).length}, с '. ': ${(dotProd ?? []).length}`);
for (const p of ((colonProd ?? []) as { name: string }[]).slice(0, 1)) await probe('имя с двоеточием как есть', String(p.name), null);
for (const p of ((dotProd ?? []) as { name: string }[]).slice(0, 1)) await probe('имя с точкой как есть', String(p.name), null);
