/**
 * READ-ONLY F6 POST-MIGRATION verification for
 * idx_product_images_product_url (product_id, image_url).
 *
 * Run AFTER the operator applies database/migrations/012 in SQL Editor.
 * SELECT only — the only intentional write attempt is a duplicate INSERT
 * that MUST fail with 23505; on unexpected success it is deleted back
 * immediately (net data change: zero) and the verification FAILS.
 */
import { readFileSync } from 'node:fs';
const root = '/home/loxord/projects/my-shop';
for (const line of readFileSync(root + '/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { createClient } = await import('@supabase/supabase-js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const c: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });

let fails = 0;
const ok = (m: string) => console.log(`PASS  ${m}`);
const bad = (m: string) => { fails += 1; console.log(`FAIL  ${m}`); };

async function paged(table: string, select: string, q = 'id'): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const PAGE = 1000;
    const r = await c.from(table).select(select).order(q).range(from, from + PAGE - 1);
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    out.push(...(r.data ?? []));
    if ((r.data ?? []).length < PAGE) return out;
    from += PAGE;
  }
}

// 1. constraint probe: duplicate pair must be REJECTED by the index.
// Take an existing row's identity verbatim.
const sample = (await c.from('product_images').select('id,product_id,image_url').limit(1)).data?.[0];
if (!sample) throw new Error('product_images пуста?!');
const dup = await c.from('product_images').insert({
  product_id: sample.product_id,
  image_url: sample.image_url,
  alt: null,
  sort_order: 999,
  is_main: false,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dupErr = dup.error as any;
if (dupErr && dupErr.code === '23505') {
  ok('constraint probe: duplicate pair отклонён (23505)');
} else if (dup.error) {
  bad(`constraint probe: отклонён, но не 23505 (${dupErr.code ?? dupErr.message})`);
} else {
  // Unexpected success → remove it back immediately and fail hard.
  await c.from('product_images').delete().eq('id', dup.data[0].id);
  bad('constraint probe: дубликат ВСТАВЛЕН и удалён назад — индекс отсутствует!');
}

// 2. data integrity vs baseline
const imgs = await paged('product_images', '*');
const pairs = new Set(imgs.map((r) => `${r.product_id}|${r.image_url}`));
if (imgs.length === 23849) ok('total=23849');
else bad(`total=${imgs.length}, ожидалось 23849`);
if (pairs.size === 23849) ok('unique pairs=23849');
else bad(`unique pairs=${pairs.size}`);
if (imgs.every((r) => r.product_id !== null && r.product_id !== undefined)) ok('NULL product_id=0');
else bad('есть NULL product_id');
if (imgs.every((r) => r.image_url !== null && r.image_url !== '')) ok('NULL/empty image_url=0');
else bad('есть NULL/empty image_url');

const ext = imgs.filter((r) => /^https?:\/\//i.test(String(r.image_url))).length;
if (ext === 23848) ok('external=23848');
else bad(`external=${ext}`);
const man = imgs.filter((r) => !/^https?:\/\//i.test(String(r.image_url)));
if (man.length === 1) ok('manual=1');
else bad(`manual=${man.length}`);

// 3. manual row unchanged (byte-compare against recorded baseline)
const m0 = man[0] ?? ({} as Record<string, unknown>);
const manOk =
  String(m0.product_id) === '145c6697-a0d2-4ade-b315-40c6c4465a4f' &&
  m0.is_main === true &&
  Number(m0.sort_order) === 0;
if (manOk) ok('manual row intact (pid/main/sort)');
else bad(`manual row изменилась: ${JSON.stringify(m0)}`);

// 4. main invariant
const mainCnt = new Map<string, number>();
for (const r of imgs) if (r.is_main === true) mainCnt.set(String(r.product_id), (mainCnt.get(String(r.product_id)) ?? 0) + 1);
let multiMain = 0;
for (const n of mainCnt.values()) if (n > 1) multiMain += 1;
if (multiMain === 0) ok('>1 main = 0');
else bad(`multi-main=${multiMain}`);

console.log(fails === 0 ? '\n== F6 POST-VERIFICATION: ALL PASS ==' : `\n== FAILS: ${fails} ==`);
process.exit(fails === 0 ? 0 : 1);
