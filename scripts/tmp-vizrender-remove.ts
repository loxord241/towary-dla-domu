// One-off: удалить смоук-тест кадры (низкое качество) из Storage —
// они были залиты для проверки канала и не должны попасть на витрину.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const paths = [
  'vizualizator/vitalnia/wc-x35554.webp',
  'vizualizator/bedroom/wc-x35554.webp',
  'vizualizator/kids/wc-x35554.webp',
  'vizualizator/manifest.json',
];
const { error, data } = await c.storage.from('product_images').remove(paths);
if (error !== null) { console.error('remove failed:', error.message); process.exit(1); }
console.log('removed', data?.length ?? 0, 'smoke files');
