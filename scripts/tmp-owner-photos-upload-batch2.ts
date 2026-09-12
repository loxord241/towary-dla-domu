// One-off (2026-09-12): залить вторую партию — 26 фото владельца (съёмка позиций без фото).
// Маппинг подтверждён владельцем: номер фото = номер строки data/wallpapers-without-photos.csv.
// Подозрительные кадры (32, 104, 105, 150) владелец подтвердил как правильные.
// Фото владельца становится ГЛАВНЫМ (существующие main — в тень).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const c: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// фото-номер → код 1С (у каждой позиции один кадр)
const PHOTO_TO_CODE: Record<string, string> = {
  '32': '40972', '46': '40337', '51': '40793', '79': '40976', '80': '40984',
  '102': '35568', '103': '36595', '104': '38943', '105': '39567', '110': '38573',
  '115': '36311', '120': '35837', '125': '36598', '131': '33307', '137': '40779',
  '142': '37486', '146': '40977', '150': '38838', '151': '40969', '170': '38030',
  '173': '36600', '180': '38545', '190': '39646', '203': '39470', '204': '40982',
  '239': '40970',
};

// product по коду: sku = wc-x<code> (без артикула — код в sku)
const codes = [...new Set(Object.values(PHOTO_TO_CODE))];
const { data: products, error } = await c
  .from('products')
  .select('id, sku, name')
  .in('sku', codes.map((code) => `wc-x${code}`));
if (error !== null) throw new Error(error.message);
const bySku = new Map((products ?? []).map((p) => [p.sku, p]));
console.log(`найдено товаров: ${bySku.size}/${codes.length}`);

let uploaded = 0, inserted = 0, demoted = 0, skipped = 0;
for (const [photo, code] of Object.entries(PHOTO_TO_CODE)) {
  const product = bySku.get(`wc-x${code}`);
  if (product === undefined) {
    console.error(`SKIP фото${photo}: товар wc-x${code} не найден`);
    skipped += 1;
    continue;
  }
  const src = `/tmp/wallphoto/${photo}.jpg`;
  const body = readFileSync(src);
  const path = `${product.sku}/owner-${photo}.jpg`;
  const { error: upErr } = await c.storage
    .from('product_images')
    .upload(path, body, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true });
  if (upErr !== null && !/exists/i.test(upErr.message)) {
    console.error(`SKIP фото${photo}: storage ${upErr.message}`);
    skipped += 1;
    continue;
  }
  uploaded += 1;

  // существующие фото этого товара: у главного снимаем is_main (владелец — главный)
  const { data: existing } = await c
    .from('product_images')
    .select('id, is_main')
    .eq('product_id', product.id)
    .eq('is_main', true);
  if (existing !== null && existing.length > 0) {
    const { error: demErr } = await c
      .from('product_images')
      .update({ is_main: false, sort_order: 5 })
      .in('id', existing.map((e) => e.id));
    if (demErr !== null) throw new Error(`demote ${product.sku}: ${demErr.message}`);
    demoted += 1;
  }

  const isMain = true; // у каждой позиции ровно один кадр в этой партии
  const { error: insErr } = await c.from('product_images').insert({
    product_id: product.id,
    image_url: path,
    is_main: isMain,
    sort_order: isMain ? -1 : 1,
    alt: product.name,
  });
  if (insErr !== null) {
    console.error(`SKIP фото${photo}: insert ${insErr.message}`);
    skipped += 1;
    continue;
  }
  inserted += 1;
}
console.log(`итог: uploaded=${uploaded} inserted=${inserted} demoted_old_main=${demoted} skipped=${skipped}`);
