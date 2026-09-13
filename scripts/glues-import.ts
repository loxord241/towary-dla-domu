#!/usr/bin/env node
/**
 * ONE-OFF (2026-09-13): import the owner's wallpaper-ADHESIVE assortment —
 * category «Клеї для шпалер» (slug `kleyi-dlya-shpaler`, child of the
 * «Шпалери» root) + 5 manual products with owner-set retail prices.
 *
 * Owner context (chat 2026-09-13): the owner picked 5 glue SKUs from photos,
 * the orchestrator researched names/specs on UA retail (Metylan/Quelyd pack
 * data cross-checked) and the owner set the prices inline. Source photos live
 * in data/glues/<sku>.png (gitignored, like the 1C exports).
 *
 * Domain rules:
 *  - sku prefix `gl-` — deliberately NOT `wc-` so the products stay OUTSIDE
 *    the wallpaper domain (WALLPAPER_SKU_PREFIX filters, roll calculator,
 *    1C stock sync). They behave as ordinary manual products: general
 *    catalog, search, suggest, sitemap (photos are the eligibility join).
 *  - category parent = `shpaleri` root → the /oboi showcase chip links to
 *    `/catalog?category=kleyi-dlya-shpaler`; the glue category slug is NOT
 *    in WALLPAPER_CATEGORY_SLUGS, so a view on it keeps wc-* excluded.
 *  - is_active is written HERE at insert time (products with photos, owner
 *    GO) — the `wallpaper-import.ts --publish` gate is scoped to wc-* and
 *    never touches gl-* rows.
 *  - stock_quantity: owner has no per-SKU counts (shop stock) — placeholder
 *    20 per SKU, adjust in the admin if needed. availability_status is
 *    derived by the migration-040 trigger.
 *
 * Idempotent: category by slug, products by sku — existing rows are reused
 * (never updated, never duplicated); images upsert by storage path.
 *
 * Usage:
 *   node scripts/glues-import.ts --plan   read-only, prints the plan
 *   node scripts/glues-import.ts --run    executes (service-role, .env.local)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** .env.local loader (same contract as scripts/wallpaper-import.ts). */
function loadEnvLocal(): void {
  try {
    for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (
        match &&
        match[1] !== undefined &&
        match[2] !== undefined &&
        process.env[match[1]] === undefined
      ) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // env vars can come from the shell too
  }
}

export const GLUE_CATEGORY = {
  name: 'Клеї для шпалер',
  slug: 'kleyi-dlya-shpaler',
  parentSlug: 'shpaleri',
} as const;

export interface GlueProductSeed {
  sku: string;
  slug: string;
  name: string;
  price: number;
  stockQuantity: number;
  shortDescription: string;
  description: string;
  specifications: { name: string; value: string }[];
  /** Photo file under data/glues/. */
  imageFile: string;
}

export const GLUE_PRODUCTS: readonly GlueProductSeed[] = [
  {
    sku: 'gl-momental-pva-200',
    slug: 'kley-momental-posylenyy-pva-200-g',
    name: 'Клей для всіх видів шпалер MOMENTAL Посилений ПВА, 200 г',
    price: 100,
    stockQuantity: 20,
    shortDescription:
      'Сухий розчинний клей із добавкою ПВА для всіх видів шпалер: вистачає на 10 рулонів, розчиняється ≈ за 10 хвилин.',
    description:
      'MOMENTAL Посилений ПВА — сухий розчинний клей для всіх видів шпалер. Добавка ПВА підсилює клейовий шар, тому полотно тримається надійніше. Швидкорозчинний: ≈ 10 хвилин до готовності, без грудок. Підходить для сухих та вологих приміщень. Однієї упаковки 200 г вистачає приблизно на 10 рулонів.',
    specifications: [
      { name: 'Бренд', value: 'MOMENTAL' },
      { name: 'Тип шпалер', value: 'усі види' },
      { name: 'Основа', value: 'посилений ПВА' },
      { name: 'Форма', value: 'сухий розчинний' },
      { name: 'Вага', value: '200 г' },
      { name: 'Розхід', value: 'до 10 рулонів (~30 м²)' },
      { name: 'Час набухання', value: '≈ 10 хв' },
      { name: 'Застосування', value: 'сухі та вологі приміщення' },
      { name: 'Країна бренду', value: 'Україна' },
    ],
    imageFile: 'gl-momental-pva-200.png',
  },
  {
    sku: 'gl-momental-pva-100',
    slug: 'kley-momental-posylenyy-pva-100-g',
    name: 'Клей для всіх видів шпалер MOMENTAL Посилений ПВА, 100 г',
    price: 60,
    stockQuantity: 20,
    shortDescription:
      'Менша фасовка посиленого ПВА-клею MOMENTAL: вистачає на 6 рулонів, для всіх видів шпалер.',
    description:
      'MOMENTAL Посилений ПВА 100 г — сухий розчинний клей для всіх видів шпалер із добавкою ПВА для посиленого зчіплення. Швидкорозчинний, без грудок, підходить для сухих та вологих приміщень. Однієї упаковки вистачає приблизно на 6 рулонів.',
    specifications: [
      { name: 'Бренд', value: 'MOMENTAL' },
      { name: 'Тип шпалер', value: 'усі види' },
      { name: 'Основа', value: 'посилений ПВА' },
      { name: 'Форма', value: 'сухий розчинний' },
      { name: 'Вага', value: '100 г' },
      { name: 'Розхід', value: 'до 6 рулонів (~20 м²)' },
      { name: 'Застосування', value: 'сухі та вологі приміщення' },
      { name: 'Країна бренду', value: 'Україна' },
    ],
    imageFile: 'gl-momental-pva-100.png',
  },
  {
    sku: 'gl-metylan-flizelin-250',
    slug: 'kley-metylan-flizelin-250-g',
    name: 'Клей для флізелінових шпалер Metylan Флізелін, 250 г',
    price: 200,
    stockQuantity: 20,
    shortDescription:
      'Спеціалізований клей Metylan для флізелінових шпалер: наноситься прямо на стіну, полотно можна коригувати. Вистачає на 5–6 рулонів (до 30 м²).',
    description:
      'Metylan Флізелін — спеціалізований клей для флізелінових шпалер (German Technologies, Henkel). Наноситься прямо на стіну — шпалерне полотно можна рухати й коригувати після приклеювання. Однієї упаковки 250 г вистачає на 5–6 рулонів (до 30 м²).',
    specifications: [
      { name: 'Бренд', value: 'Metylan' },
      { name: 'Виробник', value: 'Henkel' },
      { name: 'Тип шпалер', value: 'флізелінові' },
      { name: 'Вага', value: '250 г' },
      { name: 'Розхід', value: '5–6 рулонів (до 30 м²)' },
      { name: 'Нанесення', value: 'прямо на стіну' },
      { name: 'Особливість', value: 'коригування полотна після приклеювання' },
      { name: 'Країна', value: 'Німеччина' },
    ],
    imageFile: 'gl-metylan-flizelin-250.png',
  },
  {
    sku: 'gl-metylan-universal-250',
    slug: 'kley-metylan-universal-premium-250-g',
    name: 'Клей для всіх видів шпалер Metylan Універсал Преміум, 250 г',
    price: 180,
    stockQuantity: 20,
    shortDescription:
      'Універсальний преміум-клей Metylan для всіх видів шпалер: 8–10 рулонів (до 40 м²), з індикатором розчинення.',
    description:
      'Metylan Універсал Преміум — універсальний клей для всіх видів шпалер (German Technologies, Henkel): паперові, структурні, гофровані, дуплекс, важкі та вінілові на паперовій основі. Відмінна клейова властивість, можливість коригування шпалерного полотна, індикатор розчинення. Однієї упаковки 250 г вистачає на 8–10 рулонів (до 40 м²).',
    specifications: [
      { name: 'Бренд', value: 'Metylan' },
      { name: 'Виробник', value: 'Henkel' },
      { name: 'Тип шпалер', value: 'усі види' },
      { name: 'Вага', value: '250 г' },
      { name: 'Розхід', value: '8–10 рулонів (до 40 м²)' },
      { name: 'Особливість', value: 'індикатор розчинення, коригування полотна' },
      { name: 'Країна', value: 'Німеччина' },
    ],
    imageFile: 'gl-metylan-universal-250.png',
  },
  {
    sku: 'gl-quelyd-fliselin-300',
    slug: 'kley-quelyd-fliselin-300-g',
    name: 'Клей для флізелінових шпалер Quelyd Fliselin, 300 г',
    price: 200,
    stockQuantity: 20,
    shortDescription:
      'Французький клей Quelyd (Bostik) для всіх типів флізелінових шпалер: 7–8 рулонів (≈ 40 м²).',
    description:
      'Quelyd Fliselin — обійний клей для всіх типів флізелінових шпалер та флізеліну на флізеліновій основі. Виробник — Bostik (Франція, бренд Quelyd). Однієї упаковки 300 г вистачає на 7–8 рулонів (≈ 40 м²).',
    specifications: [
      { name: 'Бренд', value: 'Quelyd' },
      { name: 'Виробник', value: 'Bostik' },
      { name: 'Тип шпалер', value: 'флізелінові' },
      { name: 'Вага', value: '300 г' },
      { name: 'Розхід', value: '7–8 рулонів (≈ 40 м²)' },
      { name: 'Країна', value: 'Франція' },
    ],
    imageFile: 'gl-quelyd-fliselin-300.png',
  },
];

/** PLACEHOLDER stock (shop stock, owner has no per-SKU counts) — see header. */
const DEFAULT_STOCK = 20;

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== '--plan' && mode !== '--run') {
    console.error('usage: glues-import.ts --plan | --run');
    process.exit(1);
  }

  loadEnvLocal();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error('glues-import: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не налаштовані');
    process.exit(1);
  }
  const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- existing state (read-only so far) ----
  const { data: parent, error: parentErr } = await client
    .from('categories')
    .select('id, slug')
    .eq('slug', GLUE_CATEGORY.parentSlug)
    .maybeSingle();
  if (parentErr) throw new Error(`категорія ${GLUE_CATEGORY.parentSlug}: ${parentErr.message}`);
  if (!parent) throw new Error(`батьківська категорія ${GLUE_CATEGORY.parentSlug} не знайдена`);

  const { data: existingCat } = await client
    .from('categories')
    .select('id, name, slug, parent_id')
    .eq('slug', GLUE_CATEGORY.slug)
    .maybeSingle();

  const { data: existingProducts } = await client
    .from('products')
    .select('id, sku, slug')
    .in(
      'sku',
      GLUE_PRODUCTS.map((p) => p.sku)
    );
  const existingBySku = new Map((existingProducts ?? []).map((row) => [row.sku, row]));

  // ---- plan output ----
  const creates = GLUE_PRODUCTS.filter((p) => !existingBySku.has(p.sku));
  console.log('== GLUES IMPORT (plan) ==');
  console.log(
    `категорія ${GLUE_CATEGORY.slug}: ${existingCat ? `існує (id=${existingCat.id})` : 'буде СТВОРЕНА (батько ' + GLUE_CATEGORY.parentSlug + ')'}`
  );
  console.log(`товарів: ${GLUE_PRODUCTS.length}, нових: ${creates.length}, існуючих: ${GLUE_PRODUCTS.length - creates.length}`);
  for (const p of GLUE_PRODUCTS) {
    const state = existingBySku.has(p.sku) ? 'skip (існує)' : `create ${p.price} грн`;
    console.log(`  ${p.sku} → ${p.slug} :: ${state}`);
  }
  if (mode === '--plan') {
    console.log('--plan: жодних записів.');
    return;
  }

  // ---- category upsert (by slug; never renamed) ----
  let categoryId: string;
  if (existingCat) {
    categoryId = existingCat.id;
  } else {
    // Commercial position: after the wallpaper subgroups (they own lower
    // sort_order values; read the current max instead of guessing).
    const { data: sibs } = await client
      .from('categories')
      .select('sort_order')
      .eq('parent_id', (parent as { id: string }).id);
    const maxSort = Math.max(-1, ...(sibs ?? []).map((s) => s.sort_order ?? 0));
    const { data: inserted, error: catErr } = await client
      .from('categories')
      .insert({
        name: GLUE_CATEGORY.name,
        slug: GLUE_CATEGORY.slug,
        parent_id: (parent as { id: string }).id,
        sort_order: maxSort + 10,
        is_active: true,
      })
      .select('id')
      .single();
    if (catErr || !inserted) throw new Error(`категорія: ${catErr?.message ?? 'no row'}`);
    categoryId = inserted.id;
    console.log(`категорію створено: ${GLUE_CATEGORY.slug} (sort_order ${maxSort + 10})`);
  }

  // ---- products + junction + photos ----
  let created = 0;
  for (const seed of GLUE_PRODUCTS) {
    const existing = existingBySku.get(seed.sku);
    if (existing) continue;

    const { data: product, error: prodErr } = await client
      .from('products')
      .insert({
        sku: seed.sku,
        slug: seed.slug,
        name: seed.name,
        short_description: seed.shortDescription,
        description: seed.description,
        specifications: seed.specifications,
        price: seed.price,
        currency: 'UAH',
        stock_quantity: seed.stockQuantity ?? DEFAULT_STOCK,
        is_active: true,
        category_id: categoryId,
      })
      .select('id')
      .single();
    if (prodErr || !product) throw new Error(`${seed.sku}: ${prodErr?.message ?? 'no row'}`);
    const productId = (product as { id: string }).id;

    const { error: junctionErr } = await client
      .from('product_categories')
      .insert({ product_id: productId, category_id: categoryId });
    if (junctionErr && junctionErr.code !== '23505') {
      throw new Error(`${seed.sku}: junction ${junctionErr.message}`);
    }

    const imageBuffer = readFileSync(path.join(root, 'data', 'glues', seed.imageFile));
    const objectPath = `${seed.sku}/main.png`;
    const { error: upErr } = await client.storage
      .from('product_images')
      .upload(objectPath, imageBuffer, { contentType: 'image/png', upsert: true });
    if (upErr) throw new Error(`${seed.sku}: storage ${upErr.message}`);

    const { error: imgErr } = await client.from('product_images').insert({
      product_id: productId,
      image_url: objectPath,
      alt: seed.name,
      sort_order: 0,
      is_main: true,
    });
    if (imgErr && imgErr.code !== '23505') {
      throw new Error(`${seed.sku}: product_images ${imgErr.message}`);
    }

    created += 1;
    console.log(`✓ ${seed.sku} (фото ${objectPath})`);
  }

  console.log(`== Підсумок: створено ${created}, пропущено ${GLUE_PRODUCTS.length - created} ==`);
}

// Direct execution guard: tests import this module without side effects.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error('glues-import failed:', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
}
