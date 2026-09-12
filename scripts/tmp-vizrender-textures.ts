// One-off: подготовить текстуры для Windows-батча — Ланцош до 1024px по
// ширине (качество! без него Cycles-минификация + денойз дают кашу) и
// залить в Storage vizualizator-src/{slug}.png. Windows-машине тогда
// не нужен Python/Pillow — она просто скачивает готовое.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const manifest = JSON.parse(readFileSync('viz-render/render-manifest.json', 'utf8'));
let ok = 0, fail = 0;
for (const item of manifest) {
  const slug = item.slug;
  const raw = `/tmp/viztex2/raw-${slug}.tmp`;
  const out = `/tmp/viztex2/${slug}.png`;
  try {
    if (!require('node:fs').existsSync(out)) {
      const res = await fetch(item.textureUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
      const { execSync } = await import('node:child_process');
      execSync(`PYTHONPATH=/tmp/pylibs python3 /tmp/prep.py "${raw}" "${out}"`);
    }
    const body = readFileSync(out);
    const { error } = await c.storage.from('product_images').upload(`vizualizator-src/${slug}.png`, body, {
      contentType: 'image/png', cacheControl: '31536000', upsert: true,
    });
    if (error !== null && !/exists/i.test(error.message)) throw new Error(error.message);
    ok += 1;
  } catch (e) {
    fail += 1;
    console.error(`FAIL ${slug}: ${String(e).slice(0, 120)}`);
  }
}
console.log(`done: ok=${ok} fail=${fail}`);
