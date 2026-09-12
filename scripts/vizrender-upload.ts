// Заливка готовых рендеров визуализатора в Supabase Storage.
// Ожидает структуру viz-render/out/{room}/{slug}.webp (результат .bat).
// Заливает в bucket product_images под префиксом vizualizator/{room}/
// с immutable-кэшем; пишет vizualizator/manifest.json (какие связки
// room+slug отрендерены) — фронт по нему скрывает отсутствующие.
// Запуск: node --experimental-strip-types scripts/vizrender-upload.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BUCKET = 'product_images';
const PREFIX = 'vizualizator';
const ROOMS = (process.argv[2] ?? '').split(',').filter(Boolean);
if (ROOMS.length === 0) {
  console.error('Использование: vizrender-upload.ts <room1,room2,...>  (папки внутри viz-render/out/)');
  process.exit(1);
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url === '' || key === '') throw new Error('Немає SUPABASE env');
  return createClient(url, key, { auth: { persistSession: false } });
}

const supabase = client();
const manifest: Record<string, string[]> = {};

for (const room of ROOMS) {
  const dir = join('viz-render', 'out', room);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.webp'));
  } catch {
    console.warn(`${room}: папки нет — пропуск`);
    manifest[room] = [];
    continue;
  }
  let uploaded = 0;
  for (const f of files) {
    const slug = f.replace(/\.webp$/, '');
    const path = `${PREFIX}/${room}/${slug}.webp`;
    const body = readFileSync(join(dir, f));
    const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
      contentType: 'image/webp',
      cacheControl: '31536000',
      upsert: true,
    });
    if (error !== null && !/exists/i.test(error.message)) {
      console.error(`FAIL ${path}: ${error.message}`);
      continue;
    }
    uploaded += 1;
  }
  manifest[room] = files.map((f) => f.replace(/\.webp$/, ''));
  console.log(`${room}: uploaded ${uploaded}/${files.length}`);
}

await supabase.storage
  .from(BUCKET)
  .upload(`${PREFIX}/manifest.json`, JSON.stringify(manifest), {
    contentType: 'application/json',
    cacheControl: '60',
    upsert: true,
  });
console.log('manifest.json uploaded');
