/**
 * Одноразовый залив staging (wallpaper_stock) из конвертированного CSV
 * ручной 1С-выгрузки. Оркестратор, 2026-09-10. Идемпотентность НЕ нужна:
 * append-only таблица, при повторе — удалить строки export_date и перезалить.
 * Запуск: node --experimental-strip-types scripts/tmp-staging-fill.ts <csv> <date>
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

// node не читает .env.local сам — грузим вручную (паттерн yugcontract-скриптов)
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const [csvPath, exportDate] = process.argv.slice(2);
if (!csvPath || !exportDate) {
  console.error('usage: node scripts/tmp-staging-fill.ts <csv> <YYYY-MM-DD>');
  process.exit(1);
}

const raw = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const rows = raw
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('code;'))
  .map((l) => {
    const parts = l.split(';');
    const code = parts[0] ?? '';
    const name = parts[1] ?? '';
    const price = parts[4] ?? '0';
    const qty = parts[5] ?? '0';
    return {
      export_date: exportDate,
      code: code.trim(),
      name: name.trim(),
      price_retail: Number(price),
      qty: Number(qty),
    };
  });

console.log(`строк к заливу: ${rows.length}`);

const client = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let inserted = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const { error } = await client.from('wallpaper_stock').insert(chunk);
  if (error) {
    console.error(`батч ${i / 500 + 1}: FAIL ${error.message}`);
    process.exit(1);
  }
  inserted += chunk.length;
  console.log(`батч ${i / 500 + 1}: +${chunk.length} (всего ${inserted})`);
}
console.log(`DONE: ${inserted}`);
