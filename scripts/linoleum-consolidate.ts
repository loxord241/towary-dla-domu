#!/usr/bin/env node
/**
 * ЛІНОЛЕУМ CONSOLIDATE — ОДНОРАЗОВИЙ мігратор старих карток дизайн×ширина
 * у консолідовану модель (рішення власника C2, 2026-09-18: одна карточка =
 * дизайн, вибір ширини — product_variants; було 34 картки, стане 6 —
 * 4 Beauflor + Helsinki 582 + 592).
 *
 * ДЖЕРЕЛО — існуючі ln-* товари в БД (НЕ staging): price = грн/пог.м,
 * «Ширина» у specifications, stock_quantity = метраж цієї ширини. Кожна
 * стара картка парситься в LinoleumRow і годує ТОЙ САМИЙ планувальник
 * planLinoleumImport + ТОЙ САМИЙ applyPlan із scripts/linoleum-import.ts
 * (категорія, insert батчами ≤200, history, варіанти) — нічого не
 * копіюється, один шлях коду:
 *   code     — зі sku `ln-x<code>-w<token>` (нормалізація вже застосована
 *              при створенні; повторна нормалізація ідемпотентна);
 *   widthM   — токен/10 (обов'язково з LINOLEUM_WIDTHS_M);
 *   name     — ім'я картки без хвоста « {ширина} м» = ім'я дизайну;
 *   priceSqm — зі спецификації «Ціна за м²» (uk-кома → число); фолбэк —
 *              price / width (ціна картки і є runningMeterPrice);
 *   qtyM     — products.stock_quantity → сток варіанта цієї ширини.
 *
 * СТАРІ КАРТКИ (усі ln-*, що розпарсилися як старі): is_active = false —
 * diff-aware, батчами ≤200. НІКОЛИ не DELETE і НЕ зводяться в 0 цим
 * скриптом: їх sku більше не матчиться фідом, тож наступний звичайний
 * `linoleum-import --run` зведе їх в 0 через missing-шлях (з history).
 * product_images СТАРИХ карток НЕ переносяться — фото перекачає
 * `linoleum-photos --run` (матч за префіксом імені: ім'я консолідованої
 * картки = ім'я дизайну).
 *
 * Режими:
 *   node scripts/linoleum-consolidate.ts --plan
 *       Dry-run: 0 записів. Друк: скільки старих карток → скільки дизайнів,
 *       план creates/варіантів/updates, що буде сховано, некоректні картки.
 *   node scripts/linoleum-consolidate.ts --run
 *       Виконання: applyPlan (продукти + варіанти + категорія) потім hide
 *       старих активних. Повторний запуск безпечний: уже-консолідовані
 *       картки (sku без width-токена) стають existing-входом планувальника
 *       (diff-aware), hide diff-aware.
 *
 * ПОРЯДОК ВПРОВАДЖЕННЯ (оркестратор, тільки за GO власника):
 *   1) цей --run; 2) linoleum-photos --run (фото за новими іменами);
 *   3) linoleum-import --publish (вітрина). НЕ запускати на проді без GO.
 *
 * УВАГА: --run ховає живі карточки вітрини. Ідемпотентність повторного
 * --run: консолідовані картки оновлюються diff-aware; але цільовий шлях —
 * ОДИН запуск, далі чергування карток — звичайний linoleum-import.
 *
 * Restock-хук тут НЕ викликається (на відміну від linoleum-import --run):
 * консолідація не змінює наявності для клієнта — картки приходять
 * невидимими до публікації фото.
 *
 * Service-role клієнт (патерн scripts/linoleum-import.ts); креды з
 * .env.local / shell env, ніколи не логуються.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PRICE_SQM_SPEC_NAME,
  WIDTH_SPEC_NAME,
  findSpecValue,
  formatWidthM,
  planLinoleumImport,
  type ExistingProduct,
  type ExistingVariant,
  type LinoleumPlan,
} from '../app/lib/linoleum/import-plan.ts';
import { LINOLEUM_WIDTHS_M, type LinoleumRow, type LinoleumWidthM } from '../app/lib/linoleum/parse.ts';
import { LINOLEUM_SKU_PREFIX } from '../app/lib/domains.ts';
import {
  BATCH_SIZE,
  applyPlan,
  chunkRows,
  readExistingLinoleumProducts,
  readExistingVariants,
} from './linoleum-import.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Використання:
  node scripts/linoleum-consolidate.ts --plan    dry-run: друк плану, 0 записів
  node scripts/linoleum-consolidate.ts --run     міграція 34→6 батчами ≤200 + приховування старих`;

export interface LinoleumConsolidateCliArgs {
  mode: 'plan' | 'run';
}

/** Рівно ОДИН прапорець; сторонні опції → usage (одноразовий скрипт). */
export function parseArgs(argv: readonly string[]): LinoleumConsolidateCliArgs | null {
  const modes: LinoleumConsolidateCliArgs['mode'][] = [];
  for (const arg of argv) {
    if (arg === '--plan') modes.push('plan');
    else if (arg === '--run') modes.push('run');
    else return null; // unknown option → usage
  }
  if (modes.length !== 1) return null;
  const mode = modes[0];
  if (mode === undefined) return null;
  return { mode };
}

// ---------------------------------------------------------------------------
// Pure legacy-card parsing (exported for tests/linoleum-consolidate.test.ts)
// ---------------------------------------------------------------------------

/** `ln-x<code>-w<token>[-N]` → {code, widthM}; не-старий sku → null. */
export function parseLegacyCardSku(
  sku: string
): { code: string; widthM: LinoleumWidthM } | null {
  const match = sku.match(/^ln-x(.+?)-w(\d{2})(?:-\d+)?$/);
  if (match === null) return null;
  const code = match[1];
  const token = match[2];
  if (code === undefined || token === undefined || code === '') return null;
  const widthM = Number(token) / 10;
  if (!(LINOLEUM_WIDTHS_M as readonly number[]).includes(widthM)) return null;
  return { code, widthM: widthM as LinoleumWidthM };
}

/** Ім'я старої картки «{дизайн} {ширина} м» → ім'я дизайну; без хвоста → null. */
export function parseLegacyCardName(
  name: string,
  widthM: LinoleumWidthM
): string | null {
  const suffix = ` ${formatWidthM(widthM)} м`;
  if (!name.endsWith(suffix)) return null;
  const design = name.slice(0, name.length - suffix.length).trim();
  return design === '' ? null : design;
}

/** Значення «Ціна за м²» (uk-кома, канон NUMERIC(12,2)) → число. */
export function parseUkPriceValue(value: string): number | null {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type LegacyParseResult = { row: LinoleumRow } | { error: string };

/** Стара картка → фід-рядок для планувальника (див. шапку модуля). */
export function legacyRowFromProduct(product: ExistingProduct): LegacyParseResult {
  const parsedSku = parseLegacyCardSku(product.sku);
  if (parsedSku === null) {
    return { error: `sku не відповідає старій моделі дизайн×ширина` };
  }
  const design = parseLegacyCardName(product.name, parsedSku.widthM);
  if (design === null) {
    return { error: `назва без хвоста «{ширина} м»` };
  }
  const sqmRaw = findSpecValue(product.specifications, PRICE_SQM_SPEC_NAME);
  const priceSqm = sqmRaw !== undefined ? parseUkPriceValue(sqmRaw) : null;
  // Фолбэк: price картки = runningMeterPrice(sqm, width), тож обернений
  // поділ із округленням до копійки повертає ціну за м² (граничний випадок
  // HALF-UP може дати ±1 копійку — прийнятно для одноразової міграції).
  const fallbackSqm =
    priceSqm === null ? Math.round((product.price / parsedSku.widthM) * 100) / 100 : priceSqm;
  if (priceSqm === null && product.price <= 0) {
    return { error: `немає «${PRICE_SQM_SPEC_NAME}», а price ≤ 0` };
  }
  return {
    row: {
      code: parsedSku.code,
      name: design,
      widthM: parsedSku.widthM,
      priceSqm: fallbackSqm,
      qtyM: product.stockQuantity,
    },
  };
}

export interface ConsolidationPlan {
  /** Старі картки — джерело рядків (їх і буде сховано). */
  legacy: Map<string, ExistingProduct>;
  /** Уже-консолідовані картки (повторний запуск) — existing планувальника. */
  consolidatedExisting: Map<string, ExistingProduct>;
  /** ln-* картки, що не парсяться ані як старі, ані як консолідовані. */
  invalid: { sku: string; reason: string }[];
  rows: LinoleumRow[];
  plan: LinoleumPlan;
}

/**
 * Розподіл ln-* товарів на старі (джерело) / уже-консолідовані (existing) /
 * некоректні (звіт, НЕ торкаються), і план консолідації тим самим
 * planLinoleumImport, що й звичайний імпорт.
 */
export function planConsolidation(
  products: readonly ExistingProduct[],
  variants: ReadonlyMap<string, ExistingVariant>
): ConsolidationPlan {
  const legacy = new Map<string, ExistingProduct>();
  const consolidatedExisting = new Map<string, ExistingProduct>();
  const invalid: { sku: string; reason: string }[] = [];
  const rows: LinoleumRow[] = [];
  for (const product of products) {
    if (!product.sku.startsWith(LINOLEUM_SKU_PREFIX)) {
      invalid.push({ sku: product.sku, reason: 'поза доменом ln-* (defensive)' });
      continue;
    }
    const parsed = legacyRowFromProduct(product);
    if ('row' in parsed) {
      legacy.set(product.sku, product);
      rows.push(parsed.row);
      continue;
    }
    // Не старий: консолідований (sku `ln-x<code>` без width-токена) —
    // ідемпотентний повторний запуск; інакше — некоректний, тільки звіт.
    if (/^ln-x[a-z0-9-]+$/.test(product.sku)) {
      consolidatedExisting.set(product.sku, product);
    } else {
      invalid.push({ sku: product.sku, reason: parsed.error });
    }
  }
  const plan = planLinoleumImport(consolidatedExisting, rows, variants);
  return { legacy, consolidatedExisting, invalid, rows, plan };
}

/** id старих АКТИВНИХ карток → hide (diff-aware; приховані не чіпаються). */
export function planHideLegacy(legacy: readonly ExistingProduct[]): string[] {
  return legacy.filter((p) => p.isActive).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** .env.local loader (same contract as scripts/linoleum-import.ts). */
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

function printPlan(consolidation: ConsolidationPlan): void {
  const { plan, legacy, consolidatedExisting, invalid, rows } = consolidation;
  console.log(`старих карток дизайн×ширина (джерело): ${legacy.size}`);
  console.log(`уже консолідованих (повторний запуск): ${consolidatedExisting.size}`);
  console.log(`некоректних (НЕ торкаються): ${invalid.length}`);
  for (const i of invalid.slice(0, 10)) console.log(`  ? ${i.sku}: ${i.reason}`);
  console.log(`рядків ширин → варіантів: ${rows.length}`);
  console.log(`нових консолідованих карток (creates): ${plan.creates.length}`);
  for (const c of plan.creates.slice(0, 20)) {
    const widths = c.specifications
      .filter((s) => s.name === WIDTH_SPEC_NAME)
      .map((s) => s.value)
      .join('/');
    console.log(
      `  + ${c.sku} "${c.name}" price=${c.price} грн/пог.м, ширини ${widths}, ` +
        `qty=${c.stockQuantity} м, варіантів ${c.variants.length}`
    );
  }
  console.log(`updates (уже-консолідованих): ${plan.updates.length}`);
  console.log(`variant creates: ${plan.variantCreates.length}`);
  console.log(`variant updates: ${plan.variantUpdates.length}`);
  console.log(`буде сховано старих активних: ${planHideLegacy([...legacy.values()]).length}`);
  console.log('Старі картки НЕ видаляються і НЕ зводяться в 0 тут — їх зведе');
  console.log('наступний звичайний `linoleum-import --run` (missing-шлях, з history).');
  console.log('\n--plan: жодних записів.');
}

async function hideLegacyProducts(
  client: SupabaseClient,
  hideIds: readonly string[]
): Promise<number> {
  let hidden = 0;
  let batchNo = 1;
  for (const group of chunkRows([...hideIds], BATCH_SIZE)) {
    const { data, error } = await client
      .from('products')
      .update({ is_active: false })
      .in('id', group)
      .select('id')
      .returns<{ id: string }[]>();
    if (error || data === null || data.length !== group.length) {
      throw new Error(
        `батч #${batchNo} (hide legacy): ${
          error?.message ?? `отримано ${data?.length ?? 0} з ${group.length}`
        }`
      );
    }
    hidden += data.length;
    batchNo += 1;
  }
  return hidden;
}

export async function runConsolidateCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    return 1;
  }
  loadEnvLocal();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (supabaseUrl === '' || serviceKey === '') {
    console.error('Немає SUPABASE env-змінних (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
    return 1;
  }
  const { createClient } = await import('@supabase/supabase-js');
  const client: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const t0 = Date.now();
  console.log(`== LINOLEUM CONSOLIDATE (${args.mode}, ${new Date().toISOString()}) ==`);

  const products = await readExistingLinoleumProducts(client);
  const variants = await readExistingVariants(
    client,
    [...products.values()].map((p) => p.id)
  );
  const consolidation = planConsolidation([...products.values()], variants);

  if (args.mode === 'plan') {
    printPlan(consolidation);
    return 0;
  }

  // Той самий записувач, що й у звичайного --run (категорія, продукти,
  // варіанти, updates, missing, history) — жодного копійованого шляху.
  const totals = await applyPlan(
    client,
    consolidation.plan,
    consolidation.consolidatedExisting,
    variants
  );
  const hidden = await hideLegacyProducts(
    client,
    planHideLegacy([...consolidation.legacy.values()])
  );

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n== Підсумок (${elapsedS} с): консолідовано ${totals.created} нових карток ` +
      `(варіантів +${totals.variantsCreated}), оновлено ${totals.updated}, ` +
      `сховано старих ${hidden}, history ${totals.history} ==`
  );
  console.log('Далі: linoleum-photos --run (фото за іменами дизайнів) → linoleum-import --publish.');
  return 0;
}

// Direct execution guard: tests import this module without side effects.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runConsolidateCli(process.argv.slice(2))
    .then((exitCode) => process.exit(exitCode))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
