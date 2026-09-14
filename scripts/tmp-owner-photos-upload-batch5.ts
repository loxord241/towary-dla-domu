// One-off (2026-09-14): залить пятую партию — 39 фото владельца (RAW DNG, файл «33 1.DNG» = строка 33).
// Маппинг подтверждён владельцем: номер фото = номер строки data/wallpapers-without-photos.csv
// (подозрительные 30, 33, 41, 57, 62 владелец подтвердил).
// Фото владельца становится ГЛАВНЫМ, чужие фото товара удаляются (правило владельца).
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
  '27': '41044', '28': '32851', '29': '38708', '30': '36846', '31': '36453',
  '33': '39676', '34': '34632', '35': '40958', '36': '39985', '37': '34900',
  '38': '40956', '41': '33195', '43': '38640', '44': '36952', '54': '38622',
  '56': '38905', '57': '33193', '62': '34231', '63': '36652', '65': '38056',
  '66': '39963', '67': '40955', '70': '40979', '71': '40411', '72': '36454',
  '73': '36928', '74': '36831', '82': '41087', '83': '40617', '94': '36907',
  '99': '33952', '100': '40329', '119': '40432', '123': '40311', '130': '39641',
  '136': '40406', '148': '40309', '149': '39794', '161': '40980',
};

const codes = [...new Set(Object.values(PHOTO_TO_CODE))];
const { data: products, error } = await c
  .from('products')
  .select('id, sku, name')
  .in('sku', codes.map((code) => `wc-x${code}`));
if (error !== null) throw new Error(error.message);
const bySku = new Map((products ?? []).map((p) => [p.sku, p]));
console.log(`найдено товаров: ${bySku.size}/${codes.length}`);

let uploaded = 0, inserted = 0, deletedOld = 0, skipped = 0;
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
  if (upErr !== null) {
    console.error(`SKIP фото${photo}: storage ${upErr.message}`);
    skipped += 1;
    continue;
  }
  uploaded += 1;

  const { data: existing } = await c
    .from('product_images')
    .select('id, image_url')
    .eq('product_id', product.id);
  const stale = (existing ?? []);
  if (stale.length > 0) {
    const { error: delErr } = await c
      .from('product_images')
      .delete()
      .in('id', stale.map((e) => e.id));
    if (delErr !== null) throw new Error(`delete old ${product.sku}: ${delErr.message}`);
    deletedOld += stale.length;
  }

  const { error: insErr } = await c.from('product_images').insert({
    product_id: product.id,
    image_url: path,
    is_main: true,
    sort_order: -1,
    alt: product.name,
  });
  if (insErr !== null) {
    console.error(`SKIP фото${photo}: insert ${insErr.message}`);
    skipped += 1;
    continue;
  }
  inserted += 1;
}
console.log(`итог: uploaded=${uploaded} inserted=${inserted} deleted_old=${deletedOld} skipped=${skipped}`);
