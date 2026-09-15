/**
 * One-off maintenance (2026-09-15): regenerate data/category-seo-texts.sql
 * from the LIVE categories.description (the applied 049+051 texts are
 * byte-identical to what's in the DB, verified by QA). The seed file is
 * gitignored and lived only in agent worktrees — it was lost in the merge
 * shuffle; the DB is the source of truth now.
 *
 *   set -a; source .env.local; set +a
 *   node scripts/generate-seo-seed.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

try {
  for (const l of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const svc = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { persistSession: false } }
);

const { data, error } = await svc
  .from('categories')
  .select('slug, description')
  .neq('description', '')
  .not('description', 'is', null)
  .order('slug');

if (error) {
  console.error('read failed:', error.message);
  process.exit(1);
}
const rows = (data ?? []) as { slug: string; description: string }[];
console.log('categories with description:', rows.length);

const escape = (t: string) => t.replace(/'/g, "''");
const statements = rows.map(
  (r) =>
    `UPDATE categories SET description = '${escape(r.description)}' WHERE slug = '${r.slug}';`
);

const header = `-- ============================================================================
-- data/category-seo-texts.sql — сид SEO-текстов категорий.
-- Дата черновика: 2026-09-11 (шпалерные), пакеты 2026-09-14/15 (049: техника
-- и посуда, 051: следующие 50). Автор черновика: агент; владелец правит
-- тексты в админке — этот файл не источник истины. Повторный прогон не
-- нужен (UPDATE идемпотентен, но перезапишет правки владельца — после
-- ручного редактирования НЕ гонять).
--
-- Содержание: только факты о материале/основе, применении и выборе.
-- Без маркетинговых заявлений и без выдуманных фактов о магазине.
-- Апострофы экранированы удвоением ('' — SQL-escape одиночной кавычки).
-- Применение (оркестратор, MCP/SQL Editor): выполняется целиком, каждый
-- UPDATE адресует slug точечно.
-- ============================================================================

`;

writeFileSync(
  'data/category-seo-texts.sql',
  header + statements.join('\n\n') + '\n'
);
console.log('seed written:', statements.length, 'UPDATE statements');
