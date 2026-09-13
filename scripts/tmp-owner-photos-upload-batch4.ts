// One-off (2026-09-13): залить четвертую партию — 59 фото владельца (RAW DNG).
// Маппинг подтверждён владельцем: номер фото = номер строки data/wallpapers-without-photos.csv
// (подозрительные 223, 224, 185, 219, 172, 113, 108 владелец подтвердил командой «заливай все»).
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
  '39': '38940', '42': '38972', '48': '37920', '49': '38589', '58': '40855',
  '64': '40853', '68': '39291', '76': '38592', '77': '40334', '81': '40895',
  '85': '38971', '86': '36767', '87': '39571', '88': '33769', '89': '36250',
  '90': '36546', '91': '37917', '92': '39568', '93': '38594', '98': '40978',
  '108': '40975', '109': '37406', '111': '36967', '112': '38590', '113': '38593',
  '118': '31935', '121': '40425', '126': '35125', '129': '39620', '132': '37761',
  '139': '38069', '141': '37284', '143': '38839', '144': '34316', '145': '40894',
  '153': '39732', '154': '40424', '156': '39100', '157': '40854', '162': '40333',
  '166': '38727', '171': '40441', '172': '38106', '176': '40973', '179': '36428',
  '181': '37925', '184': '35130', '185': '39619', '186': '36439', '192': '38689',
  '210': '37290', '219': '38875', '223': '39170', '224': '36216', '226': '39830',
  '234': '36636', '237': '38775', '241': '35129', '252': '38670',
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

  // чужие/старые фото товара удаляем (правило владельца: моё фото — единственное)
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
