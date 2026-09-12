import { buildOrganizationJsonLd, serializeJsonLd } from '@/app/lib/schema-org';

/**
 * Site-wide Organization/LocalBusiness JSON-LD (SEO audit P2, 2026-09-12),
 * rendered once from the root layout so every SSR page carries the graph.
 * Same sanctioned sink pattern as ProductJsonLd/FaqJsonLd: the payload is
 * built exclusively by buildOrganizationJsonLd from hardcoded factual
 * constants and serialized with '<'-escaping.
 */
export default function OrganizationJsonLd() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
  const data = buildOrganizationJsonLd(siteUrl);
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
