// Генератор манифеста для офлайн-рендера визуализатора (Blender-батч).
// Активные wc-* с фото → viz-render/render-manifest.json:
//   [{ slug, name, textureUrl, rollWidthCm }]
// Рендер-машина (Windows .bat владельца) читает манифест, качает текстуры,
// рендерит {room}/{slug}.webp и заливает в Storage (vizrender-upload.ts).
// Запуск: node --experimental-strip-types scripts/vizrender-manifest.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRollSize } from '../app/lib/wallpapers/parse.ts';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url === '' || key === '') throw new Error('Немає SUPABASE env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return createClient(url, key, { auth: { persistSession: false } });
}

const supabase = client();
const { data, error } = await supabase
  .from('products')
  .select('slug, name, images:product_images!inner(image_url, is_main, sort_order)')
  .like('sku', 'wc-%')
  .eq('is_active', true)
  .order('name', { ascending: true })
  .limit(1000);
if (error !== null) throw new Error(error.message);

const rows = (data ?? []).map((row: {
  slug: string; name: string;
  images: { image_url: string; is_main: boolean | null; sort_order: number | null }[];
}) => {
  const sorted = [...(row.images ?? [])].sort(
    (a, b) =>
      Number(b.is_main ?? false) - Number(a.is_main ?? false) ||
      (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  return {
    slug: row.slug,
    name: row.name,
    textureUrl: getPublicImageUrl(sorted[0]?.image_url ?? ''),
    rollWidthCm: parseRollSize(row.name)?.widthCm ?? null,
  };
}).filter((r) => r.textureUrl !== '');

writeFileSync('viz-render/render-manifest.json', JSON.stringify(rows, null, 1));
console.log(`manifest: ${rows.length} товаров → viz-render/render-manifest.json`);

function getPublicImageUrl(path: string): string | null {
  if (path === '') return null;
  if (/^https?:\/\//.test(path)) return path;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  return base === '' ? null : `${base}/storage/v1/object/public/product_images/${path}`;
}
