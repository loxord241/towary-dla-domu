/**
 * Description drafts (spec
 * docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md,
 * Phase 2) — pure decision layer between the Phase-1 generation core and
 * the two I/O surfaces:
 *   - scripts/description-generate.ts (CLI --plan/--run, staging writer)
 *   - app/api/admin/descriptions/route.ts (owner approve/reject API)
 *
 * RESPONSIBILITY SPLIT (mirrors content-import/content-staging):
 *   - ALL generated text comes from app/lib/description-generator.ts
 *     (Phase 1) — nothing is re-phrased or invented here; this module only
 *     decides WHO is a draft target and PACKAGES the generated content
 *     into the draft columns (lead = plain text, description_text = the
 *     minimal escaped HTML that products.description is stored as).
 *   - products.description is written ONLY by the approved branch
 *     (migration 050 function approve_product_description_draft) — the
 *     CLI never touches products.
 *
 * TARGET SEGMENT (spec §7, сегмент №1): ACTIVE products with ≥3
 * renderable specifications (LEAD_MIN_SPECS) and an EMPTY/placeholder
 * description — placeholder detection is the same isPlaceholderDescription
 * the PDP uses (app/lib/product-description.ts), so «заглушка сегодня →
 * полный текст после approve» is exactly the owner-visible diff.
 */

import { isPlaceholderDescription } from './product-description.ts';
import { sanitizeSpecRows } from './product-specifications.ts';
import {
  buildGeneratedDescription,
  buildLeadParagraph,
  LEAD_MIN_SPECS,
} from './description-generator.ts';

/** Drafts produced by the CLI carry this source tag (migration 050 default). */
export const DRAFT_SOURCE = 'spec-generator-v1';

/** Write windows ≤200 (yc_content_batches convention). */
export const DESCRIPTION_DRAFT_BATCH_SIZE = 200;

/** Admin list page size (≤50 per the Phase-2 contract). */
export const DESCRIPTION_DRAFT_PAGE_SIZE = 50;

/**
 * Minimal product projection the CLI loads (see the SELECT in
 * scripts/description-generate.ts): brand name and category slug arrive
 * via the same FK embeds the PDP uses (products_brand_id_fkey /
 * products_category_id_fkey).
 */
export interface DraftSourceProduct {
  id: string;
  name: string;
  sku: string;
  slug: string;
  description: string | null;
  specifications: unknown;
  brand_name?: string | null;
  category_slug?: string | null;
}

export interface DescriptionDraftContent {
  /** Лид-абзац (plain text; '' когда фактов на лид не хватило). */
  lead: string;
  /** Текст «Опис» — minimal escaped HTML (products.description is an HTML column). */
  descriptionText: string;
}

/**
 * Целевой сегмент Фазы 2: ≥3 характеристик (sanitized, как их видит PDP) и
 * пустой/placeholder description. is_active НЕ проверяется здесь — это
 * обязанность запроса (structural filter), не данных строки.
 */
export function isDraftTarget(
  row: {
    description: string | null | undefined;
    specifications: unknown;
  },
  /** Rewrite mode (2026-09-15, спека §9 сегмент №2): target is ALSO
      products with a real (non-placeholder) supplier description — the
      generated factual text replaces brand boilerplate. */
  opts: { rewrite?: boolean } = {}
): boolean {
  if (sanitizeSpecRows(row.specifications).length < LEAD_MIN_SPECS) return false;
  return opts.rewrite === true || isPlaceholderDescription(row.description);
}

/** Escape a text node for embedding into the products.description HTML column. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Пакет черновика из ядра Фазы 1. null → товар пропускается (черновик не
 * создаётся): ядро не смогло высказать ≥2 фактов — по спеке §5/§8.4
 * «нет данных — предложение не пишется», фиктивный текст не сочиняем.
 *
 * descriptionText упаковывает buildGeneratedDescription в ту форму, в
 * которой живёт products.description (HTML-колонка; на PDP её рендерит
 * ProductDescription — единственный контролируемый HTML-sink проекта):
 * список фич → <ul>, абзац → <p>. Каждая строка ядра экранируется ЦЕЛИКОМ
 * (значения фида — внешние данные: <, &, кавычки не должны стать
 * разметкой), поэтому sanitizer на импорте не нужен — текст по
 * построению плоский и безопасный.
 */
export function buildDraftContent(
  row: DraftSourceProduct,
  opts: { rewrite?: boolean } = {}
): DescriptionDraftContent | null {
  if (!isDraftTarget(row, opts)) return null;

  const lead = buildLeadParagraph({
    name: row.name,
    brand: row.brand_name ?? null,
    specifications: row.specifications,
    categorySlug: row.category_slug ?? null,
  });

  const generated = buildGeneratedDescription({
    name: row.name,
    specifications: row.specifications,
    categorySlug: row.category_slug ?? null,
  });
  if (!generated || generated.lines.length === 0) return null;

  const descriptionText =
    generated.format === 'list'
      ? `<ul>${generated.lines
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join('')}</ul>`
      : `<p>${escapeHtml(generated.lines.join(' '))}</p>`;

  return { lead, descriptionText };
}

// ---------------------------------------------------------------------------
// Admin API payload parsing (pure, source-pinned by tests)
// ---------------------------------------------------------------------------

export type DraftAction = 'approve' | 'reject';

export interface DraftActionPayload {
  id: string;
  action: DraftAction;
}

/**
 * Strict PATCH body for /api/admin/descriptions: { id: uuid, action }.
 * null → caller answers 400. Nothing else is accepted — a typo'd action
 * must never fall through to a default (approve is irreversible-ish:
 * it publishes the draft text onto the product).
 */
export function parseDraftAction(body: unknown): DraftActionPayload | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  if (b.action !== 'approve' && b.action !== 'reject') return null;
  return { id, action: b.action };
}
