/**
 * Wallpapers import (Task 4): category mapping for the daily 1C 7.7 stock feed.
 *
 * The owner's 1С report groups the wallpaper stock into 10 subgroups. This
 * module is the ONLY place where those subgroup names are mapped to storefront
 * categories: a «Шпалери» root plus 10 Ukrainian-named children.
 *
 * `planCategoryUpsert` is a pure planner (same pattern as
 * app/lib/yugcontract/import-plan.ts): everything is decided BEFORE any write
 * so the executor (CLI, Task 7) can show the exact plan and stay idempotent.
 * Identity rule: category slug. If a slug already exists the row is reused —
 * never duplicated, never renamed (name mismatch → conflict, reported only).
 */

/** Storefront root category for the whole wallpapers domain. */
export const WALLPAPER_ROOT = {
  name: 'Шпалери',
  slug: 'shpaleri',
} as const;

export interface WallpaperCategoryTarget {
  /** Ukrainian storefront name (uk is the site content language). */
  name: string;
  slug: string;
}

/**
 * Key = subgroup name EXACTLY as it appears in the owner's 1С report
 * (Russian, original casing — matching is done by the importer reading the
 * CSV/staging rows). Values are the storefront name + slug.
 * Object order mirrors the 1С report order and is preserved by
 * `planCategoryUpsert` creates.
 */
export const WALLPAPER_CATEGORY_MAP: Record<string, WallpaperCategoryTarget> = {
  'Акрил': { name: 'Акрил', slug: 'shpaleri-akryl' },
  'Винил 10 м': { name: 'Вініл 10 м', slug: 'shpaleri-vinyl-10m' },
  'Винил 15 м': { name: 'Вініл 15 м', slug: 'shpaleri-vinyl-15m' },
  'Дуплекс': { name: 'Дуплекс', slug: 'shpaleri-duplex' },
  'Метровые': { name: 'Метрові', slug: 'shpaleri-metrovi' },
  'ФЛИЗЕЛИН': { name: 'Флізелін', slug: 'shpaleri-flizelin' },
  'ШЕЛКОГРАФИЯ': { name: 'Шовкографія', slug: 'shpaleri-shovkografiya' },
  'Мойка простая': { name: 'Мійка проста', slug: 'shpaleri-miika-prosta' },
  'Обои простые': { name: 'Прості шпалери', slug: 'shpaleri-prosti' },
  'Супермойка': { name: 'Супермійка', slug: 'shpaleri-supermiika' },
};

export interface ExistingWallpaperCategory {
  slug: string;
  name: string;
  /**
   * Present in the `categories` projection the executor reads; the plan
   * itself decides by slug+name only (re-parenting existing rows is out of
   * scope — conflicts are reported instead).
   */
  parentId: string | null;
  id: string;
}

export interface WallpaperCategoryCreate {
  slug: string;
  name: string;
  /** Slug of the parent row; `null` only for the «Шпалери» root itself. */
  parentSlug: string | null;
}

export interface WallpaperCategoryUpsertPlan {
  /** Root first, then children in 1С report order (parents precede children). */
  creates: WallpaperCategoryCreate[];
  /**
   * 1С subgroup key → id of the EXISTING category reused for it.
   * Slugs planned as creates are absent here — the executor takes their ids
   * from the INSERT results.
   */
  links: Record<string, string>;
  /** Slugs that exist under a different (incompatible) name; never touched. */
  conflicts: string[];
}

/**
 * Case/whitespace-insensitive name key that also folds the Cyrillic letters
 * which differ between the Russian 1С report and Ukrainian storefront spellings
 * (и/ы → і, э → е): «Винил 10 м» ≡ «Вініл 10 м», «ФЛИЗЕЛИН» ≡ «Флізелін».
 * Pairs where the words themselves differ (Шелкография/Шовкографія,
 * Мойка/Мійка…) are handled by comparing against BOTH the target name and the
 * 1С source key in `isNameCompatible`.
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[иы]/g, 'і')
    .replace(/э/g, 'е');
}

function isNameCompatible(
  targetName: string,
  sourceKey: string | null,
  actualName: string
): boolean {
  const actual = normalizeName(actualName);
  if (actual === normalizeName(targetName)) return true;
  return sourceKey !== null && actual === normalizeName(sourceKey);
}

/**
 * Pure upsert plan for the wallpaper category tree against existing rows.
 *
 * Decisions per desired category (root first, then the 10 subgroups):
 *  - slug missing          → create (never a duplicate);
 *  - slug exists + name compatible → reuse, `links[subgroupKey] = id`;
 *  - slug exists + incompatible name → `conflicts`, row untouched.
 *
 * Compatible means the existing name equals the Ukrainian target name or the
 * 1С source key, case/whitespace-insensitively with ru↔uk letter folding.
 * Calling with `[]` yields 11 creates (root + 10) and empty links; feeding the
 * applied result back yields zero creates and a fully populated `links` map
 * (idempotency contract, pinned by tests/wallpaper-categories.test.ts).
 */
export function planCategoryUpsert(
  existing: readonly ExistingWallpaperCategory[]
): WallpaperCategoryUpsertPlan {
  const bySlug = new Map(existing.map((row) => [row.slug, row]));

  const creates: WallpaperCategoryCreate[] = [];
  const links: Record<string, string> = {};
  const conflicts: string[] = [];

  const rootRow = bySlug.get(WALLPAPER_ROOT.slug);
  if (!rootRow) {
    creates.push({
      slug: WALLPAPER_ROOT.slug,
      name: WALLPAPER_ROOT.name,
      parentSlug: null,
    });
  } else if (!isNameCompatible(WALLPAPER_ROOT.name, null, rootRow.name)) {
    conflicts.push(WALLPAPER_ROOT.slug);
  }

  for (const [sourceKey, target] of Object.entries(WALLPAPER_CATEGORY_MAP)) {
    const row = bySlug.get(target.slug);
    if (!row) {
      creates.push({
        slug: target.slug,
        name: target.name,
        parentSlug: WALLPAPER_ROOT.slug,
      });
    } else if (isNameCompatible(target.name, sourceKey, row.name)) {
      links[sourceKey] = row.id;
    } else {
      conflicts.push(target.slug);
    }
  }

  return { creates, links, conflicts };
}
