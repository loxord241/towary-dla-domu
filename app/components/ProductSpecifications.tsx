import {
  sanitizeSpecRows,
  type ProductSpecificationsRow,
} from '@/app/lib/product-specifications';

/**
 * «Характеристики товару» — supplier characteristics from
 * products.specifications (JSONB array of {name,value}).
 *
 * SECURITY: values are plain database strings rendered as React text
 * children — raw HTML is never interpreted. Duplicate names are VALID
 * data and must be preserved as separate rows. Empty/invalid entries are
 * skipped; the whole block disappears when nothing renderable remains.
 */
export default function ProductSpecifications({
  specifications,
  variant = 'section',
  heading,
}: {
  specifications: ProductSpecificationsRow[] | null | undefined;
  /**
   * 'section' — full-width card below the product grid (default).
   * 'inline'   — compact block for the description slot inside the details
   * card (PDP UX: shown only when the «Опис» section has nothing to render;
   * see app/product/[slug]/page.tsx). Empty rows hide BOTH variants.
   */
  variant?: 'section' | 'inline';
  /**
   * Optional heading override (Epicentr-style intro, spec 2026-09-14):
   * ProductIntro reuses the inline markup for «Основні характеристики».
   * Defaults keep the historical strings — section «Характеристики товару»,
   * inline «Характеристики».
   */
  heading?: string;
}) {
  const rows = sanitizeSpecRows(specifications);
  if (rows.length === 0) return null;

  const headingText = heading ?? (variant === 'inline' ? 'Характеристики' : 'Характеристики товару');

  const table = (
    <table className="w-full table-fixed border-collapse text-sm">
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${i}`} className="border-b border-gray-100 last:border-b-0">
            <th
              scope="row"
              className="w-2/5 py-2 pr-3 text-left align-top font-normal text-gray-500 break-words [overflow-wrap:anywhere]"
            >
              {row.name}
            </th>
            <td className="py-2 text-left align-top text-gray-900 break-words [overflow-wrap:anywhere]">
              {row.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (variant === 'inline') {
    return (
      <div className="mb-6">
        <h3 className="mb-2 font-semibold text-gray-900">{headingText}</h3>
        {table}
      </div>
    );
  }

  return (
    <section className="bg-white rounded-lg shadow p-6 mb-8">
      <h2 className="text-xl font-bold mb-4">{headingText}</h2>
      {table}
    </section>
  );
}
