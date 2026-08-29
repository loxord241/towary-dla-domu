import { serializeJsonLd } from '@/app/lib/schema-org';

/**
 * The SECOND sanctioned dangerouslySetInnerHTML sink of the whole app/
 * (the first is ProductDescription). Input is built exclusively by
 * buildProductJsonLd and buildProductBreadcrumbJsonLd from DB values and
 * serialized with '<'-escaping, so no stored string can terminate the
 * script element early.
 */
export default function ProductJsonLd({
  data,
}: {
  data: Record<string, unknown> | null;
}) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
