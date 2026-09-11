// One-off (2026-09-11): удалить из Storage product_images файлы-сироты,
// оставшиеся после чистки 64 авто-матченных product_images строк
// (бэкап: data/backup-mirrored-images-20260911.json, /tmp/to-delete.json).
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const toDelete: { id: string; sku: string; image_url: string }[] = JSON.parse(
  readFileSync('data/deleted-mirrored-image-ids-20260911.json', 'utf8'),
);
const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
const paths = toDelete.map((r) => r.image_url);
const { error } = await client.storage.from('product_images').remove(paths);
if (error !== null) {
  console.error('remove failed:', error.message);
  process.exit(1);
}
console.log(`removed ${paths.length} storage objects`);
