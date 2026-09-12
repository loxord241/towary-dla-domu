// One-off: расширенный manifest.json (rooms + textures) в Storage.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, '') + '/storage/v1/object/public/product_images/';
const manifest = JSON.parse(readFileSync('viz-render/render-manifest.json', 'utf8'));
const out = {
  rooms: ['vitalnia', 'bedroom', 'kids'],
  textures: Object.fromEntries(manifest.map((r: { slug: string }) => [r.slug, base + 'vizualizator-src/' + r.slug + '.png'])),
  rendered: {} as Record<string, string[]>,
};
const { error } = await c.storage.from('vizualizator').upload('manifest.json', JSON.stringify(out), {
  contentType: 'application/json', cacheControl: '60', upsert: true,
});
if (error !== null) { console.error('FAIL:', error.message); process.exit(1); }
console.log('manifest.json uploaded:', Object.keys(out.textures).length, 'текстур');
