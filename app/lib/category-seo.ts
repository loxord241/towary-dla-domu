import type { Metadata } from 'next';
import type { Category } from './catalog';
import { compareCategories } from './category-tree.ts';

/**
 * Category-level SEO layer (2026-08). Pure and runtime-dependency-free
 * (type-only import from catalog.ts) so node:test loads it without Supabase.
 *
 * The storefront request «товари для дому» matches the shop brand and the
 * domain. The pinned category below already carries the merchandising
 * anchor «Товари для дому» in the nav drawer; this module gives it the
 * matching intent copy, an H1, footer anchor reuse and child-category
 * links. Every other category keeps the generic metadata behavior.
 */

/** The category pinned to the commercial intent «товари для дому». */
export const TDD_CATEGORY_SLUG = 'hospodarchi-tovary-1451';

export interface CategorySeoOverride {
  /** Page H1 for the category view (single h1 per page is preserved). */
  h1: string;
  /** <title> override; the canonical/noindex decision is NOT affected. */
  title: string;
  /** meta description override. */
  description: string;
  /** Unique Ukrainian intro paragraphs rendered above the product grid. */
  intro: string[];
  /** Heading above the direct-children link list. */
  introHeading: string;
}

const OVERRIDES: Record<string, CategorySeoOverride> = {
  [TDD_CATEGORY_SLUG]: {
    h1: 'Товари для дому',
    title: 'Товари для дому — купити в інтернет-магазині Товари для дому',
    description:
      'Товари для дому в інтернет-магазині «Товари для дому»: господарчі товари для прибирання, зберігання та догляду за оселею. Доставка по всій Україні.',
    intro: [
      'У цьому розділі зібрані товари для дому, які щодня потрібні в кожній оселі: господарчі дрібниці, приладдя для прибирання, зберігання речей і догляд за кімнатними рослинами. Асортимент підбирається для щоденних господарських задач — від дрібного ремонту до підтримання порядку.',
      'Щоб швидше знайти потрібне, скористайтеся підкатегоріями нижче або фільтрами в каталозі. Замовлення доставляємо по всій Україні, а ключові характеристики кожної позиції вказані на сторінці товару.',
    ],
    introHeading: 'Підкатегорії',
  },
};

/** Override for the pinned slug, null for everything else. */
export function getCategorySeo(
  slug: string | undefined
): CategorySeoOverride | null {
  if (!slug) return null;
  return OVERRIDES[slug] ?? null;
}

/**
 * Merge the SEO copy override into already-built catalog view metadata.
 * Indexability/robots/canonical fields are never touched here — the
 * decision stays exclusively in lib/seo.ts.
 */
export function applyCategorySeoMetadata<
  M extends Partial<Pick<Metadata, 'title' | 'description'>>,
>(metadata: M, categorySlug: string | undefined): M {
  const seo = getCategorySeo(categorySlug);
  return seo
    ? ({ ...metadata, title: seo.title, description: seo.description } as M)
    : metadata;
}

/**
 * Direct children of `parentId` from the already-fetched active category
 * list — no extra DB reads. Sorted by the shared commercial rule
 * (sort_order, then ukrainian name, then id) so the rendered link list
 * matches the order used everywhere else in the storefront.
 */
export function listDirectChildren(
  categories: Category[],
  parentId: string
): Category[] {
  return categories
    .filter((category) => category.parent_id === parentId)
    .sort(compareCategories);
}
