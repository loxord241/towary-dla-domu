// One-off (2026-09-11): дамп активных wc-* товаров без фото для Excel-списка
// владельцу (data/oboi-bez-foto-2026-09-11.xlsx).
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const { data: withImages, error } = await client
  .from('products')
  .select('sku, slug, name, price, stock_quantity, availability_status, images:product_images(image_url), product_categories(category_id, categories(name))')
  .like('sku', 'wc-%')
  .eq('is_active', true);
if (error !== null) throw new Error(error.message);
const noPhoto = (withImages ?? [])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .filter((p: any) => (p.images ?? []).length === 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .map((p: any) => ({
    sku: p.sku,
    slug: p.slug,
    name: p.name,
    price: Number(p.price),
    stock: p.stock_quantity,
    categories: (p.product_categories ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((pc: any) => pc?.categories?.name)
      .filter(Boolean)
      .join(', '),
  }))
  .sort((a: { price: number; stock: number }, b: { price: number; stock: number }) =>
    b.price * b.stock - a.price * a.stock,
  );
writeFileSync('/tmp/no-photo.json', JSON.stringify(noPhoto, null, 1));
console.log(`dumped ${noPhoto.length} rows`);
