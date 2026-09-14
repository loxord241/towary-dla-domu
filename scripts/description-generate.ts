/**
 * Description DRAFTS generator (spec
 * docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md,
 * Phase 2) — по образцу scripts/yugcontract-content-apply.ts.
 *
 * Reads ACTIVE products (paged, deterministic .order('id')) and writes
 * lead + description drafts into the product_description_drafts staging
 * table (migration 050). products.description is NEVER touched here —
 * the only writer of products.description is the approved branch of the
 * admin API (атомарный RPC из миграции 050).
 *
 * Modes:
 *   node scripts/description-generate.ts --plan
 *       read-only: target-segment counts + 3 examples (product → lead → text)
 *   node scripts/description-generate.ts --run --limit N [--category slug]
 *       batch-generate drafts (windows ≤200, deterministic order).
 *       Existing drafts are NEVER overwritten (INSERT .. ON CONFLICT
 *       (product_id) DO NOTHING via upsert + ignoreDuplicates).
 *
 * Decision/packaging logic lives in app/lib/description-drafts.ts (pure,
 * unit-tested); this script is I/O + CLI args only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Type-only static import: fully erased before execution.
import type { DraftSourceProduct } from '../app/lib/description-drafts.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

const {
  DRAFT_SOURCE,
  DESCRIPTION_DRAFT_BATCH_SIZE,
  isDraftTarget,
  buildDraftContent,
} = await import('../app/lib/description-drafts.ts');

const mode = process.argv.includes('--run')
  ? 'run'
  : process.argv.includes('--plan')
    ? 'plan'
    : null;
if (!mode) {
  console.error('Використання: --plan | --run --limit N [--category slug] [--rewrite]');
  process.exit(1);
}

const limitIdx = process.argv.indexOf('--limit');
const rewrite = process.argv.includes('--rewrite');
const limitRaw = limitIdx !== -1 ? process.argv[limitIdx + 1] : undefined;
const limit = mode === 'run' ? Math.max(0, Math.floor(Number(limitRaw ?? '200')) || 0) : 0;
if (mode === 'run' && limit <= 0) {
  console.error('Вкажіть --limit N (> 0), напр. --run --limit 50');
  process.exit(1);
}

const catIdx = process.argv.indexOf('--category');
const categorySlug = catIdx !== -1 ? (process.argv[catIdx + 1] ?? '') : '';

const fmtInt = (n: number): string => n.toLocaleString('uk-UA');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('Немає SUPABASE env-змінних');
  process.exit(1);
}
const { createClient } = await import('@supabase/supabase-js');
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const t0 = Date.now();
console.log(`== DESCRIPTION DRAFTS (${mode}, ${new Date().toISOString()}) ==`);

// --category slug → products.category_id (the same default assignment the
// PDP renders as «Категорія:»; junction parents are out of scope here).
let categoryId: string | null = null;
if (categorySlug) {
  const { data, error } = await client
    .from('categories')
    .select('id')
    .eq('slug', categorySlug)
    .maybeSingle();
  if (error || !data) {
    console.error(`Категорію «${categorySlug}» не знайдено`);
    process.exit(1);
  }
  categoryId = data.id;
  console.log(`фільтр категорії: ${categorySlug} → ${categoryId}`);
}

// Same FK embeds the PDP uses (products_brand_id_fkey /
// products_category_id_fkey): brand name and category slug feed the
// Phase-1 core exactly the inputs ProductIntro passes on the card.
const PRODUCT_COLUMNS =
  'id, name, sku, slug, description, specifications, ' +
  'brand_name:brands!products_brand_id_fkey(name), ' +
  'category_slug:categories!products_category_id_fkey(slug)';

type ProductRow = DraftSourceProduct & {
  brand_name?: { name: string } | null;
  category_slug?: { slug: string } | null;
};

/**
 * One deterministic window of ACTIVE products (.order('id') — stable
 * multi-page paging, OFFSET without ORDER BY overlaps, live-verified in
 * the content importer). Window ≤200 rows.
 */
async function loadWindow(from: number): Promise<ProductRow[]> {
  let q = client
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('is_active', true)
    .order('id')
    .range(from, from + DESCRIPTION_DRAFT_BATCH_SIZE - 1);
  if (categoryId) q = q.eq('category_id', categoryId);
  const { data, error } = await q;
  if (error) {
    console.error(`Помилка читання products: ${error.message}`);
    process.exit(1);
  }
  return (data ?? []) as unknown as ProductRow[];
}

/** Flatten the FK embeds into the DraftSourceProduct shape. */
function toSource(p: ProductRow): DraftSourceProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    slug: p.slug,
    description: p.description,
    specifications: p.specifications,
    brand_name: p.brand_name?.name ?? null,
    category_slug: p.category_slug?.slug ?? null,
  };
}

const counters = { scanned: 0, targets: 0, generatable: 0 };
const examples: Array<{ name: string; sku: string; lead: string; text: string }> = [];

if (mode === 'plan') {
  for (let from = 0; ; from += DESCRIPTION_DRAFT_BATCH_SIZE) {
    const rows = await loadWindow(from);
    if (rows.length === 0) break;
    counters.scanned += rows.length;
    for (const raw of rows) {
      const p = toSource(raw);
      if (!isDraftTarget(p, { rewrite })) continue;
      counters.targets += 1;
      const draft = buildDraftContent(p, { rewrite });
      if (!draft) continue;
      counters.generatable += 1;
      if (examples.length < 3) {
        examples.push({ name: p.name, sku: p.sku, lead: draft.lead, text: draft.descriptionText });
      }
    }
  }

  const { count: pendingCount } = await client
    .from('product_description_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  console.log(`переглянуто активних товарів:        ${fmtInt(counters.scanned)}`);
  console.log(`цільовий сегмент (≥3 характеристик + порожній/placeholder опис): ${fmtInt(counters.targets)}`);
  console.log(`  з них генерований текст вийде:     ${fmtInt(counters.generatable)}`);
  console.log(`  пропущено (ядро висловило <2 фактів): ${fmtInt(counters.targets - counters.generatable)}`);
  console.log(`чернеток уже в staging (pending):   ${fmtInt(pendingCount ?? 0)}`);
  for (const ex of examples) {
    console.log('\n---');
    console.log(`${ex.name} (${ex.sku})`);
    console.log(`лід: ${ex.lead || '—'}`);
    console.log(`опис: ${ex.text}`);
  }
  console.log('\n--plan: жодних записів.');
  process.exit(0);
}

// ---- real run: write drafts, never touch products ----------------------------
let written = 0;
let alreadyExisted = 0;

for (let from = 0; written < limit; from += DESCRIPTION_DRAFT_BATCH_SIZE) {
  const rows = await loadWindow(from);
  if (rows.length === 0) break;

  const batch: Array<{ product_id: string; lead: string; description_text: string; source: string }> = [];
  for (const raw of rows) {
    const p = toSource(raw);
    if (!isDraftTarget(p, { rewrite })) continue;
    counters.targets += 1;
    const draft = buildDraftContent(p, { rewrite });
    if (!draft) continue;
    batch.push({
      product_id: p.id,
      lead: draft.lead,
      description_text: draft.descriptionText,
      source: DRAFT_SOURCE,
    });
  }
  counters.scanned += rows.length;
  if (batch.length === 0) continue;

  // --limit counts NEW drafts written: never exceed the remaining quota,
  // even when the current window holds more targets than the owner asked for.
  const remaining = limit - written;
  const chunk = batch.slice(0, remaining);

  // ON CONFLICT (product_id) DO NOTHING: an existing draft (any status)
  // is never overwritten — re-runs are idempotent. (supabase-js 2.112:
  // the DO NOTHING insert is expressed as upsert + ignoreDuplicates; a
  // conflicting row is merged with nothing and NOT returned.)
  const { data, error } = await client
    .from('product_description_drafts')
    .upsert(
      chunk,
      { onConflict: 'product_id', ignoreDuplicates: true }
    )
    .select('product_id');

  if (error) {
    console.error(`Помилка запису чернеток: ${error.message}`);
    console.error('(Міграція 050 застосована? Таблиця product_description_drafts існує?)');
    process.exit(1);
  }

  const inserted = data?.length ?? 0;
  alreadyExisted += chunk.length - inserted;
  written += inserted;
  console.log(
    `✓ вікно #${Math.floor(from / DESCRIPTION_DRAFT_BATCH_SIZE) + 1}: цілей ${batch.length}, до запису ${chunk.length}, нових чернеток ${inserted}, уже існувало ${chunk.length - inserted} (разом нових: ${written}/${limit})`
  );
}

console.log(
  `\n== Підсумок (${((Date.now() - t0) / 1000).toFixed(1)} с): переглянуто ${fmtInt(counters.scanned)} активних, цілей ${fmtInt(counters.targets)}, записано нових чернеток ${fmtInt(written)}, пропущено існуючих ${fmtInt(alreadyExisted)} ==`
);
console.log('products НЕ змінено — чернетки чекають на затвердження в /admin/descriptions.');
