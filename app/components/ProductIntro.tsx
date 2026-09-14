import ProductSpecifications from '@/app/components/ProductSpecifications';
import {
  buildGeneratedDescription,
  buildKeySpecs,
  buildLeadParagraph,
  LEAD_MIN_SPECS,
} from '@/app/lib/description-generator';
import { sanitizeSpecRows } from '@/app/lib/product-specifications';

/**
 * Epicentr-style PDP intro (spec
 * docs/superpowers/specs/2026-09-14-epicentr-description-pattern.md,
 * Phase 1). Renders, in the Epicentr order:
 *   1. лид-абзац under H1/price — facts only from specifications/brand/name,
 *      shown when the product has ≥3 renderable specifications
 *      (LEAD_MIN_SPECS) and at least two voiceable facts;
 *   2. «Основні характеристики» — top-5 spec rows by the category priority
 *      dictionary, reusing the ProductSpecifications inline markup;
 *   3. for products WITHOUT a real description — a generated «Опис»
 *      (feature list for appliances, fact paragraph otherwise) in place of
 *      the old text-placeholder path.
 *
 * SERVER component: all generation is pure .ts (description-generator),
 * no hooks, no client bundle cost. Real supplier descriptions keep their
 * priority — the generated «Опис» renders only when `hasRealDescription`
 * is false (the page passes its existing shouldRenderDescriptionSection
 * result), while lead + «Основні характеристики» ADD to both segments.
 *
 * TRUTHFULNESS: every string comes from description-generator, which never
 * invents facts (see its header invariant). Values are React text children
 * — no HTML sink here.
 */
export default function ProductIntro({
  name,
  brandName,
  specifications,
  categorySlug,
  hasRealDescription,
}: {
  name: string;
  brandName?: string | null;
  specifications: { name: string; value: string }[] | null | undefined;
  categorySlug?: string | null;
  hasRealDescription: boolean;
}) {
  const rows = sanitizeSpecRows(specifications);

  // Лид і «Основні характеристики» мають сенс лише коли є що виносити:
  // ≥3 характеристик (spec §7: 89,5% активних товарів).
  const showIntro = rows.length >= LEAD_MIN_SPECS;
  const lead = showIntro
    ? buildLeadParagraph({ name, brand: brandName, specifications, categorySlug })
    : '';
  const keySpecs = showIntro
    ? buildKeySpecs(specifications, categorySlug ?? null)
    : [];

  // Згенерований «Опис» — ТІЛЬКИ для товарів без реального тексту; товари
  // з описом отримують лід + «Основні характеристики» зверху існуючого блока.
  const generated = hasRealDescription
    ? null
    : buildGeneratedDescription({ name, specifications, categorySlug });

  if (lead === '' && keySpecs.length === 0 && generated === null) return null;

  return (
    <>
      {lead !== '' && (
        <p className="mb-6 text-sm leading-relaxed text-gray-700">{lead}</p>
      )}
      {keySpecs.length > 0 && (
        <ProductSpecifications
          specifications={keySpecs}
          variant="inline"
          heading="Основні характеристики"
        />
      )}
      {generated !== null && (
        <div className="mb-6">
          <h3 className="mb-2 font-semibold text-gray-900">Опис</h3>
          {generated.format === 'list' ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
              {generated.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm leading-relaxed text-gray-700">
              {generated.lines.join(' ')}
            </p>
          )}
        </div>
      )}
    </>
  );
}
