/**
 * Pure import planner for the 1C linoleum stock (linoleum vertical,
 * CONSOLIDATED CARD MODEL — рішення власника C2, 2026-09-18: «одна карточка
 * = дизайн, всі ширини — в одній карточці», а не 34 картки дизайн×ширина).
 * Mirrors app/lib/wallpapers/import-plan.ts: everything is decided BEFORE any
 * write so the CLI executor (scripts/linoleum-import.ts) can show the exact
 * plan and stay idempotent. No Next.js / DB imports — unit-tested with
 * node:test.
 *
 * Identity rule (consolidated, C2): ОДНА карточка = ДИЗАЙН; вибір ширини —
 * product_variants на PDP (варіантний шлях place_order, міграція 006:
 * order_items.variant_id, ціна/сток/availability беруться з варіанта).
 * Per feed row (LinoleumRow, one row = одна ширина дизайну з добового
 * експорту 1С):
 *   - ГРУПА = дизайн по name з CSV (designKey: trim + lowercase + пробіли
 *     вирізані — той самий recipe, що в normalizeCode, але БЕЗ digits-фолбэка:
 *     кириличні імена не схлопуються в цифри). Display-name групи = ім'я
 *     першої стрічки (порядок першої появи, детерміновано).
 *   - product sku = `ln-x<нормалізований код 1С>` БЕЗ width-токена. Код
 *     береться зі стрічки САМОЇ ВУЗЬКОЇ ширини групи (канонічний порядок
 *     LINOLEUM_WIDTHS_M) — детерміновано і незалежно від порядку стрічок
 *     викачки. Реальний фід: всі ширини дизайну несуть один код 1С; якби коди
 *     різнилися — перейменування/зникнення найвужчої ширини змінило б sku
 *     (задокументоване обмеження виводу v1).
 *   - normalizeCode: trim + lowercase + пробіли вирізані; коди вже всередині
 *     charset'у [a-z0-9-] проходять як є, коди з символами поза ним
 *     (кирилиця: «ЛІН-01160049») → digits-only core («01160049») — той самий
 *     рецепт, що в батчі 2; виживша колізія (два коди з спільним digits-яд­ром)
 *     розв'язується суфіксом `-2`, `-3`, … детерміновано.
 *   - variant sku = `{productSku}-w<width×10>` (`1.5→15, 2→20, 2.5→25, 3→30,
 *     3.5→35, 4→40`). UNIQUE у product_variants ✓. Збігається зі sku старих
 *     карток дизайн×ширина, але це ІНША таблиця — колізії з products.sku немає.
 *
 * Card display decisions (consolidated):
 *   - products.name = ім'я дизайну БЕЗ ширини («SUGAR OAK 997L Лінолеум
 *     BEAUFLOUR SMARTEX»); перейменування дизайну у фіді = НОВА карточка
 *     (стара зведеться в 0 через missing-шлях, is_active не тріпається);
 *   - products.price = MIN грн/погонний метр по ширинах = MIN
 *     runningMeterPrice(price_sqm, width_m) — бейдж «від X грн» на вітрині;
 *   - products.stock_quantity = СУМА метражів варіантів цієї групи. ВІДОМЕ
 *     ОБМЕЖЕННЯ v1 (задокументовано, рішення C2): декременти продажів ідуть
 *     по ВАРІАНТАХ (place_order, 006), products.stock_quantity залишається
 *     знімком імпорту і після продажів розсинхронізується з варіантами;
 *     реальні залишки — product_variants.stock_quantity. Синхронізацію
 *     product-стоку при продажі НЕ додаємо (money-path, §17).
 *   - specifications (jsonb array): `{name:'Ціна за м²', value:'350,50'}`
 *     (formatPriceSqmValue: рівно 2 знаки, кома — канон NUMERIC(12,2), значення
 *     = MIN price_sqm групи — бейдж «від X грн/м²») + ПО ОДНІЙ записі
 *     `{name:'Ширина', value: formatWidthM(w)}` на КОЖНУ ширину
 *     (formatWidthM: `1,5`/`2`/`2,5`/`3`/`3,5`/`4` — канон фільтра хаба).
 *     Кілька записів «Ширина» в одному масиві: hub-фільтр
 *     `contains([{Ширина:'2'}])` матчить масив, що МІСТИТЬ елемент, тож
 *     карточка з ширинами 1,5/2/2,5 відповідає фільтру «2»
 *     (app/lib/catalog/linoleum-listing.ts). Канонічний порядок ширин —
 *     за зростанням LINOLEUM_WIDTHS_M, незалежно від порядку стрічок фіду.
 *
 * product_variants (по стрічці на ширину):
 *   - name = formatWidthM(width) («1,5»/«2»/…), price = грн/погонний метр =
 *     runningMeterPrice(price_sqm, width_m) (HALF-UP до копійки, як Postgres
 *     NUMERIC), stock_quantity = qty_m (INTEGER ✓), availability_status —
 *     тригер міграції 040 виводить його зі stock_quantity (на INSERT пишеться
 *     узгоджене значення плану), is_active = true.
 *
 * Plan semantics (pinned by tests/linoleum-import-plan.test.ts):
 *   - rows deduplicated by (code, width_m); the LAST row for a key wins;
 *     всередині групи дублікати ОДНІЄЇ ширини (два коди одного дизайну+ширина
 *     на картці невиразні) теж зводяться «остання перемагає»;
 *   - creates: slug === sku, availability по сумарному метражу (0 →
 *     out_of_stock), isActive always false — публікація це окремий фото-гейт
 *     (CLI --publish), ніколи не рішення планувальника; варіанти активні;
 *   - product updates: diff-aware, ONLY fields that actually diverge:
 *       price           — stored MIN-пог.м ≠ computed;
 *       specifications  — переписуються ЦІЛИКОМ при розбіжності: канон 1С
 *                         («Ціна за м²» + канонічний список «Ширина») ПЕРШИМ
 *                         блоком, потім тех-записи сайту як є (L12: імпортер
 *                         володіє лише каноном — «Клас зносостійкості»,
 *                         «Товщина», «Виробник» тощо переживають синк;
 *                         збережені записи з іменами канону не виживають);
 *       stock_quantity  — stored сума ≠ feed-сумі;
 *     name/sku/slug/is_active існуючих не торкаються;
 *   - variant updates: diff price/stock_quantity по variant sku; ім'я
 *     («Ширина») не переписується — (дизайн, ширина) і є ідентичністю
 *     варіанта; availability_status/is_active на UPDATE не пишуться
 *     (тригер 040 / територія адмінки);
 *   - missing width (ширина зникла з викачки) → variant stock_quantity = 0;
 *   - missing product (весь дизайн пішов) → product stock 0 + всі його
 *     варіанти stock 0; DELETE НІКОЛИ;
 *   - conflicts: always [] by contract — the executor pre-filters the
 *     existing-products read to the ln-* domain.
 *
 * Idempotency contract: feeding the planner its own applied output (creates
 * materialized, updates applied, missing zeroed) again produces empty
 * creates/updates/missing and every domain sku in noops.
 *
 * Migration note (C2): перший --run на БД, де ще живі старі картки
 * дизайн×ширина, створить консолідовані картки ПАРАЛЕЛЬНО до старих; старі
 * зведуться в 0 наступним --run (їх sku більше не матчиться) і ховаються
 * --publish'ом або одноразовим scripts/linoleum-consolidate.ts. Цільовий
 * шлях впровадження — спершу консолідація.
 *
 * Categories: the linoleum subtree currently is exactly its root category
 * (LINOLEUM_ROOT_CATEGORY — «Лінолеум», slug = LINOLEUM_ROOT_SLUG);
 * planRootCategory is the pure create-or-reuse-or-conflict decision for the
 * CLI executor (importer never renames: a slug under a different name is a
 * conflict).
 */

import type { LinoleumRow, LinoleumWidthM } from './parse.ts';
import { LINOLEUM_WIDTHS_M } from './parse.ts';
import { LINOLEUM_SKU_PREFIX } from '../domains.ts';

/** Specification entry names, canon of the hub width filter (jsonb contains). */
export const PRICE_SQM_SPEC_NAME = 'Ціна за м²';
export const WIDTH_SPEC_NAME = 'Ширина';

export type SpecificationEntry = { name: string; value: string };

/** Storefront root category for the whole linoleum domain (uk name). */
export const LINOLEUM_ROOT_CATEGORY = {
  name: 'Лінолеум',
  slug: 'linoleum',
} as const;

/** A product row the executor already read from the DB (ln-* domain). */
export interface ExistingProduct {
  id: string;
  sku: string;
  name: string;
  /** грн за погонный метр (products.price). */
  price: number;
  stockQuantity: number;
  isActive: boolean;
  /** Parsed specifications jsonb ([] when null/absent). */
  specifications: SpecificationEntry[];
}

/** A product_variants row the executor already read from the DB. */
export interface ExistingVariant {
  id: string;
  /** Globally UNIQUE — derived `{productSku}-w{token}` matches by sku. */
  sku: string;
  productId: string;
  /** formatWidthM(width) — never rewritten on update (variant identity). */
  name: string;
  /** грн за погонный метр (product_variants.price). */
  price: number;
  stockQuantity: number;
}

export type LinoleumAvailability = 'in_stock' | 'out_of_stock';

/** A product_variants row the planner wants the executor to INSERT. */
export interface LinoleumVariantPlanRow {
  /** `{productSku}-w<width×10>` — UNIQUE у product_variants. */
  sku: string;
  /** formatWidthM(width): «1,5»/«2»/… (канон спеки «Ширина»). */
  name: string;
  /** грн за погонный метр = runningMeterPrice(priceSqm, widthM). */
  price: number;
  stockQuantity: number;
  availability: LinoleumAvailability;
  /** Завжди true: варіанти приходять активними (контракт C2). */
  isActive: true;
}

/** A product the planner wants the executor to INSERT (consolidated card). */
export interface LinoleumPlanRow {
  sku: string;
  /** Equals `sku` (the sku is already slug-safe by construction). */
  slug: string;
  /** Ім'я дизайну БЕЗ ширини (карточка = дизайн). */
  name: string;
  /** MIN грн/пог.м по ширинах групи («від X грн»). */
  price: number;
  /** СУМА метражів варіантів (див. обмеження v1 у шапці модуля). */
  stockQuantity: number;
  availability: LinoleumAvailability;
  /** Always false: publishing is the CLI --publish photo-presence gate. */
  isActive: false;
  /** `[Ціна за м² (MIN), Ширина ×N]` — see module doc. */
  specifications: SpecificationEntry[];
  /** По стрічці на ширину, канонічний порядок LINOLEUM_WIDTHS_M. */
  variants: LinoleumVariantPlanRow[];
}

/** A partial UPDATE restricted to the fields that actually diverged. */
export interface LinoleumPlanUpdate {
  id: string;
  fields: {
    price?: number;
    stock_quantity?: number;
    specifications?: SpecificationEntry[];
  };
}

/** New width on an EXISTING product → product_variants INSERT. */
export interface LinoleumVariantCreate {
  productId: string;
  variant: LinoleumVariantPlanRow;
}

/** A partial product_variants UPDATE (price / stock_quantity only). */
export interface LinoleumVariantUpdate {
  id: string;
  fields: {
    price?: number;
    stock_quantity?: number;
  };
}

export interface LinoleumPlan {
  creates: LinoleumPlanRow[];
  updates: LinoleumPlanUpdate[];
  /** Нові ширини в існуючих продуктів → product_variants INSERT. */
  variantCreates: LinoleumVariantCreate[];
  /** Diff-оновлення існуючих варіантів (price / stock_quantity). */
  variantUpdates: LinoleumVariantUpdate[];
  /** ln-* продукти поза фідом і ще не на 0 (→ product OOS write). */
  missingProducts: { id: string }[];
  /** Варіанти ширин, що зникли (→ variant OOS write); DELETE ніколи. */
  missingVariants: { id: string }[];
  /** Skus with no pending write this run (exact matches + reconciled missing). */
  noops: string[];
  /** Always [] (contract): domain filtering happens upstream in the executor. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// canonical formatters (single source for name + specs + future hub filter)
// ---------------------------------------------------------------------------

/** Width in uk comma format: `1.5→"1,5"`, `2→"2"` (see module doc). */
export function formatWidthM(widthM: LinoleumWidthM): string {
  return String(widthM).replace('.', ',');
}

/** «Ціна за м²» value: exactly 2 decimals with a comma (`350.5→"350,50"`). */
export function formatPriceSqmValue(priceSqm: number): string {
  return (Math.round(priceSqm * 100) / 100).toFixed(2).replace('.', ',');
}

/**
 * грн за погонный метр = price_sqm × width_m, HALF-UP to a kopiyka.
 * Integer-cents math: price_sqm carries ≤2 decimals (NUMERIC(12,2) canon →
 * exact cents via Math.round), width × 2 is a small exact integer
 * (3|4|5|6|7|8), so `(cents × widthHalf) / 2` is exact binary float and
 * Math.round resolves the `.5` cases HALF-UP — the same rounding Postgres
 * NUMERIC applies (naive `Math.round(priceSqm * widthM * 100)` loses on
 * binary representation: 10.15×1.5 = 15.224999… → 15.22 instead of 15.23).
 */
export function runningMeterPrice(priceSqm: number, widthM: LinoleumWidthM): number {
  const priceCents = Math.round(priceSqm * 100);
  const widthHalf = Math.round(widthM * 2);
  return Math.round((priceCents * widthHalf) / 2) / 100;
}

/** Width token inside the variant sku: width × 10 (`1.5→"15"`, `2→"20"`). */
function skuWidthToken(widthM: LinoleumWidthM): string {
  return String(Math.round(widthM * 10));
}

/** Same recipe as the wallpaper article key: trim + lowercase, no whitespace.
 *  Codes already inside the slug charset [a-z0-9-] pass through unchanged
 *  (back-compat with every already-issued sku); anything carrying characters
 *  outside it — real supplier codes are often Cyrillic («ЛІН-01160049») —
 *  falls back to its DIGITS-ONLY core, keeping skus/slugs in [a-z0-9-]
 *  (owner task L7, 2026-09-17). */
function normalizeCode(code: string): string {
  const base = code.trim().toLowerCase().replace(/\s+/g, '');
  if (/^[a-z0-9-]+$/.test(base)) return base;
  return (base.match(/\d+/g) ?? []).join('');
}

/** Групування за дизайном: trim + lowercase + без пробілів (як normalizeCode,
 *  але БЕЗ digits-фолбэка — кириличні імена дизайнів не схлопуються). */
export function designKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

/** `ln-x<code>` — sku КОНСОЛІДОВАНОЇ карточки (дизайн, без width-токена). */
export function linoleumSku(code: string): string {
  return `${LINOLEUM_SKU_PREFIX}x${normalizeCode(code)}`;
}

/** `{productSku}-w<width×10>` — sku варіанта, UNIQUE у product_variants. */
export function linoleumVariantSku(productSku: string, widthM: LinoleumWidthM): string {
  return `${productSku}-w${skuWidthToken(widthM)}`;
}

/** Stored «Ціна за м²» value, or undefined when the entry is absent. */
export function findSpecValue(
  specs: readonly SpecificationEntry[],
  name: string
): string | undefined {
  return specs.find((s) => s.name === name)?.value;
}

/**
 * Канон specifications консолідованої карточки — ПЕРШИМ блоком, у власному
 * канонічному порядку: «Ціна за м²» (перерахований MIN) + «Ширина» ×N за
 * зростанням LINOLEUM_WIDTHS_M (сортуються тут — незалежно від порядку
 * входу). ПІСЛЯ канону — усі інші записи існуючої карточки («Клас
 * зносостійкості», «Товщина», «Основа», «Виробник», «Країна виробник» —
 * джерело: карточки магазинів, не 1С) як є, у вихідному порядку (задача
 * L12, 2026-09-18: імпортер володіє ЛИШЕ каноном 1С, тех-записи сайту
 * переживають синк). Збережені записи з іменами канону не виживають:
 * «Ширина» — дані карточки (список ширин перераховується з фіду),
 * «Ціна за м²» — перераховується; «extra» з іменем «Ширина» неможливий —
 * канон перемагає.
 */
export function buildConsolidatedSpecifications(
  stored: readonly SpecificationEntry[],
  priceSqmValue: string,
  widths: readonly LinoleumWidthM[]
): SpecificationEntry[] {
  const extras = stored.filter(
    (s) => s.name !== PRICE_SQM_SPEC_NAME && s.name !== WIDTH_SPEC_NAME
  );
  const sorted = [...widths].sort(
    (a, b) => widthOrder(a) - widthOrder(b)
  );
  return [
    { name: PRICE_SQM_SPEC_NAME, value: priceSqmValue },
    ...sorted.map((w) => ({ name: WIDTH_SPEC_NAME, value: formatWidthM(w) })),
    ...extras,
  ];
}

/** Strict equality of specification lists (entries are flat name/value). */
export function specificationListsEqual(
  a: readonly SpecificationEntry[],
  b: readonly SpecificationEntry[]
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Скільки тех-записів САЙТУ (не-«Ціна за м²», не-«Ширина» — «Клас
 * зносостійкості», «Товщина», «Основа», «Виробник», «Країна виробник» тощо,
 * джерело: карточки магазинів, не 1С) план ПЕРЕНОСИТЬ у нові specifications
 * через оновлення (задача L12, 2026-09-18: імпортер володіє лише каноном 1С
 * — «Ціна за м²» + «Ширина»×N; решта записів існуючої карточки зберігається
 * as-is). Оновлення без перезапису specs (тільки price/stock) зберігають
 * extra тривіально — у лічильник вони не потрапляють. Метрика для друку
 * --plan у CLI («збережено тех-записей: N»).
 */
export function preservedTechSpecCount(plan: LinoleumPlan): number {
  let count = 0;
  for (const update of plan.updates) {
    for (const entry of update.fields.specifications ?? []) {
      if (entry.name !== PRICE_SQM_SPEC_NAME && entry.name !== WIDTH_SPEC_NAME) {
        count += 1;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// root category plan (create-or-reuse-or-conflict; importer never renames)
// ---------------------------------------------------------------------------

/** A category row the executor already read from the DB. */
export interface ExistingCategoryRow {
  id: string;
  slug: string;
  name: string;
}

export interface RootCategoryPlan {
  /** INSERT {name, slug: LINOLEUM_ROOT_CATEGORY} (root, parent_id null). */
  create: boolean;
  /** id of the existing root row when create === false. */
  existingId: string | null;
  /** true = the slug exists under a different name → executor aborts. */
  conflict: boolean;
}

export function planRootCategory(
  existing: readonly ExistingCategoryRow[]
): RootCategoryPlan {
  const row = existing.find((c) => c.slug === LINOLEUM_ROOT_CATEGORY.slug);
  if (row === undefined) return { create: true, existingId: null, conflict: false };
  if (row.name.trim() !== LINOLEUM_ROOT_CATEGORY.name) {
    return { create: false, existingId: null, conflict: true };
  }
  return { create: false, existingId: row.id, conflict: false };
}

// ---------------------------------------------------------------------------
// the planner (consolidated: one card per design, widths = variants)
// ---------------------------------------------------------------------------

/** Canonical width ordering index (1.5 → 4). */
function widthOrder(widthM: LinoleumWidthM): number {
  const idx = (LINOLEUM_WIDTHS_M as readonly LinoleumWidthM[]).indexOf(widthM);
  return idx === -1 ? LINOLEUM_WIDTHS_M.length : idx;
}

/** Variant plan row for one feed row of a design. */
function buildVariantPlanRow(
  productSku: string,
  row: LinoleumRow
): LinoleumVariantPlanRow {
  return {
    sku: linoleumVariantSku(productSku, row.widthM),
    name: formatWidthM(row.widthM),
    price: runningMeterPrice(row.priceSqm, row.widthM),
    stockQuantity: row.qtyM,
    availability: row.qtyM > 0 ? 'in_stock' : 'out_of_stock',
    isActive: true,
  };
}

export function planLinoleumImport(
  existing: Map<string, ExistingProduct>,
  rows: LinoleumRow[],
  existingVariants: ReadonlyMap<string, ExistingVariant>
): LinoleumPlan {
  // Dedup by (code, width_m): last row for a key wins; JS Map keeps the
  // first-appearance order, which makes the plan deterministic. The `|`
  // separator is collision-free here: the width suffixes
  // (`|1.5`,`|2`,`|2.5`,`|3`,`|3.5`,`|4`) share no suffix relation, so
  // `code1|w1 === code2|w2` implies `code1 === code2 && w1 === w2`.
  const byKey = new Map<string, LinoleumRow>();
  for (const row of rows) byKey.set(`${row.code}|${row.widthM}`, row);

  // Group by DESIGN (name from the feed): one card per design, widths are
  // variants. Groups keep first-appearance order; the display name is the
  // first-seen row's name.
  const groups = new Map<string, { name: string; rows: LinoleumRow[] }>();
  for (const row of byKey.values()) {
    const key = designKey(row.name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { name: row.name, rows: [row] });
    else group.rows.push(row);
  }

  // Existing variants indexed by parent product (missing-variant detection).
  const variantsByProduct = new Map<string, ExistingVariant[]>();
  for (const variant of existingVariants.values()) {
    const list = variantsByProduct.get(variant.productId);
    if (list === undefined) variantsByProduct.set(variant.productId, [variant]);
    else list.push(variant);
  }

  const creates: LinoleumPlanRow[] = [];
  const updates: LinoleumPlanUpdate[] = [];
  const variantCreates: LinoleumVariantCreate[] = [];
  const variantUpdates: LinoleumVariantUpdate[] = [];
  const missingProducts: { id: string }[] = [];
  const missingVariants: { id: string }[] = [];
  const noops: string[] = [];
  const conflicts: string[] = [];
  // Product skus already decided this run (matched an existing row or claimed
  // by a create) — used to resolve collisions with a `-N` suffix.
  const claimed = new Set<string>();

  for (const group of groups.values()) {
    // Within a design the variant identity IS the width: two codes of the
    // same design+width are indistinguishable on the card (variant name =
    // «Ширина»), so same-width rows collapse last-wins, mirroring the
    // (code,width) dedup above. Then canonical ascending width order.
    const byWidth = new Map<LinoleumWidthM, LinoleumRow>();
    for (const row of group.rows) byWidth.set(row.widthM, row);
    const widthRows = [...byWidth.values()].sort(
      (a, b) => widthOrder(a.widthM) - widthOrder(b.widthM)
    );
    // Сама вузька ширина групи дає код для product sku (детерміновано,
    // незалежно від порядку стрічок викачки).
    const narrowest = widthRows[0]!;
    const baseSku = linoleumSku(narrowest.code);
    // Only the FIRST group of this run may claim an existing product.
    const found = claimed.has(baseSku) ? undefined : existing.get(baseSku);

    if (found !== undefined) {
      claimed.add(baseSku);
      const variantRows = widthRows.map((r) => buildVariantPlanRow(baseSku, r));
      const expectedPrice = Math.min(...variantRows.map((v) => v.price));
      const expectedSum = variantRows.reduce((sum, v) => sum + v.stockQuantity, 0);
      const minSqm = Math.min(...widthRows.map((r) => r.priceSqm));
      const expectedSpecs = buildConsolidatedSpecifications(
        found.specifications,
        formatPriceSqmValue(minSqm),
        widthRows.map((r) => r.widthM)
      );

      const fields: LinoleumPlanUpdate['fields'] = {};
      if (found.price !== expectedPrice) fields.price = expectedPrice;
      if (!specificationListsEqual(found.specifications, expectedSpecs)) {
        fields.specifications = expectedSpecs;
      }
      if (found.stockQuantity !== expectedSum) fields.stock_quantity = expectedSum;
      if (
        fields.price === undefined &&
        fields.stock_quantity === undefined &&
        fields.specifications === undefined
      ) {
        noops.push(baseSku);
      } else {
        updates.push({ id: found.id, fields });
      }

      const plannedVariantSkus = new Set<string>();
      for (const variant of variantRows) {
        plannedVariantSkus.add(variant.sku);
        const ev = existingVariants.get(variant.sku);
        if (ev === undefined) {
          variantCreates.push({ productId: found.id, variant });
          continue;
        }
        const vFields: LinoleumVariantUpdate['fields'] = {};
        if (ev.price !== variant.price) vFields.price = variant.price;
        if (ev.stockQuantity !== variant.stockQuantity) {
          vFields.stock_quantity = variant.stockQuantity;
        }
        if (vFields.price === undefined && vFields.stock_quantity === undefined) {
          noops.push(variant.sku);
        } else {
          variantUpdates.push({ id: ev.id, fields: vFields });
        }
      }
      // Ширини, що зникли з дизайну: варіант зводиться в 0 (ніколи DELETE).
      for (const ev of variantsByProduct.get(found.id) ?? []) {
        if (plannedVariantSkus.has(ev.sku)) continue;
        if (ev.stockQuantity !== 0) missingVariants.push({ id: ev.id });
        else noops.push(ev.sku);
      }
      continue;
    }

    let sku = baseSku;
    let n = 2;
    while (claimed.has(sku) || existing.has(sku)) {
      sku = `${baseSku}-${n}`;
      n += 1;
    }
    claimed.add(sku);
    const variantRows = widthRows.map((r) => buildVariantPlanRow(sku, r));
    const minSqm = Math.min(...widthRows.map((r) => r.priceSqm));
    const stockSum = variantRows.reduce((sum, v) => sum + v.stockQuantity, 0);
    creates.push({
      sku,
      slug: sku,
      name: group.name,
      price: expectedMinPrice(variantRows),
      stockQuantity: stockSum,
      availability: stockSum > 0 ? 'in_stock' : 'out_of_stock',
      isActive: false,
      specifications: [
        { name: PRICE_SQM_SPEC_NAME, value: formatPriceSqmValue(minSqm) },
        ...widthRows.map((r) => ({
          name: WIDTH_SPEC_NAME,
          value: formatWidthM(r.widthM),
        })),
      ],
      variants: variantRows,
    });
  }

  // Positions that left the feed: product stock → 0 AND all its variant
  // stocks → 0 (never DELETE); already-reconciled ones are plain noops.
  for (const [sku, product] of existing) {
    if (!sku.startsWith(LINOLEUM_SKU_PREFIX)) continue; // defensive: pre-filtered upstream
    if (claimed.has(sku)) continue;
    if (product.stockQuantity !== 0) missingProducts.push({ id: product.id });
    else noops.push(sku);
    for (const ev of variantsByProduct.get(product.id) ?? []) {
      if (ev.stockQuantity !== 0) missingVariants.push({ id: ev.id });
      else noops.push(ev.sku);
    }
  }

  return {
    creates,
    updates,
    variantCreates,
    variantUpdates,
    missingProducts,
    missingVariants,
    noops,
    conflicts,
  };
}

/** MIN грн/пог.м по варіантах групи (бейдж «від X грн»). */
function expectedMinPrice(variantRows: readonly LinoleumVariantPlanRow[]): number {
  return Math.min(...variantRows.map((v) => v.price));
}
